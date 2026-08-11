//! The phase machine and the bonus cascade.
//!
//! Per game on purpose: this is precisely where the two Clever titles differ.
//! This one adds a pre-roll return window, resets its +1 flags per *round*
//! rather than per turn, forbids a wasted pick with the silver die, and chains
//! a silver placement onto every die that pick swept to the platter. Sharing
//! this machine is what forces a hardcoded `'silver'` into a prototype's core.

#[cfg(test)]
use clever_core::Face;
use clever_core::{
    rate, Actions, Bar, Breakdown, Die, DieSet, Error, Loc, Mat, Node, Pending, Pips, Rating,
    RngCore, Round, Score, Solitaire, Stats, Unlock,
};

use crate::action::{Action, BonusPick};
use crate::color::Color;
use crate::describe::Described;
use crate::effect::{Choice, Effect, FreeTarget};
use crate::sheet::{DieMarks, Placement, Sheet};

/// How many decisions can wait at once.
///
/// Measured, not assumed: over 20 000 uniform-random games the queue never
/// holds more than **four**, and a policy that plays for the deepest queue it
/// can find reaches only three. The cascade graph agrees — a mark fires at
/// most two bonuses, resolving one consumes a cell, and the platter chain adds
/// at most a *single* row choice to a pick. It is worth being explicit about
/// the last point: the dice that queue a row choice (wild and silver) are
/// exactly the dice that can make a silver placement in the first place, so at
/// most one of them is ever among the moved dice. The design document's guess
/// of five is an over-estimate by four.
///
/// Eight is kept: it is the bound PR 1 defended, an entry is two bytes, and
/// the headroom over the observed four is the margin a rules change would
/// otherwise silently eat.
pub const PENDING: usize = 8;

/// Where in a round the game stands.
///
/// The two `Roll` phases are the game's only chance nodes; everything else is
/// a decision — including [`Phase::PreRoll`], the return window, which the
/// base game's machine has no counterpart for.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Phase {
    /// Decision: spend returns on platter dice, or roll on. Entered only when
    /// a return is banked *and* the platter is non-empty.
    PreRoll,
    /// Chance: re-roll the pool.
    Roll,
    /// Decision: pick a die, re-roll, or forfeit the roll.
    Pick,
    /// Decision: spend +1s, then end the active turn.
    EndTurn,
    /// Chance: roll all six, the three lowest to the platter.
    PassiveRoll,
    /// Decision: take one platter die, or decline.
    PassivePick,
    /// Decision: spend +1s, then end the round.
    PassiveEndTurn,
    /// The game has finished.
    Over,
}

/// Which action bar an unlock circles. Three here, against the base game's
/// two.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BarKind {
    Reroll,
    Plus1,
    Return,
}

impl BarKind {
    /// What circling this bar's **last** slot grants. Every bar on this sheet
    /// has one, which is what makes [`Unlock::Filled`] load-bearing here.
    const fn end_bonus(self) -> Effect {
        match self {
            BarKind::Reroll => Effect::Fox,
            BarKind::Plus1 => Effect::Free(FreeTarget::Silver),
            BarKind::Return => Effect::Free(FreeTarget::Pink),
        }
    }
}

/// A solo game of *Twice as Clever*.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TwiceAsClever {
    round: Round,
    phase: Phase,
    picks: u8,
    mat: Mat<6>,
    sheet: Sheet,
    reroll: Bar,
    plus1: Bar,
    ret: Bar,
    plus1_used: DieSet,
    foxes: u8,
    pending: Pending<Choice, PENDING>,
    stats: Stats,
}

/// Whether a decision can still be taken, read off the sheet alone.
///
/// A free function rather than a method so it can be handed to
/// [`Pending::retain_resolvable`] while the queue is borrowed mutably.
fn resolvable(sheet: &Sheet, choice: Choice) -> bool {
    match choice {
        Choice::Free(target) => sheet.free(target).next().is_some(),
        Choice::SilverRow(value) => sheet.silver_rows(value).next().is_some(),
        Choice::Black => FreeTarget::ALL
            .iter()
            .any(|&t| sheet.free(t).next().is_some()),
    }
}

impl TwiceAsClever {
    /// How many rounds the solo game lasts.
    pub const ROUNDS: Round = match Round::new(6) {
        Some(r) => r,
        None => Round::FIRST,
    };

    /// How many dice an active turn may place.
    pub const PICKS_PER_TURN: u8 = 3;

    /// How many slots each of the three action bars prints. One fewer than the
    /// base game's seven — and every one of them ends in a bonus.
    pub const BAR_SLOTS: u8 = 6;

    /// What the round track grants at the start of each round.
    const ROUND_BONUS: [Option<Effect>; 6] = [
        Some(Effect::Reroll),
        Some(Effect::Plus1),
        Some(Effect::Return),
        Some(Effect::Black),
        None,
        None,
    ];

    /// The solo rating table, highest first.
    ///
    /// The rulebook names only the bottom and top tiers; the nine in between
    /// are 20-point bands with labels in the base game's spirit.
    pub const RATING: [Rating; 11] = [
        Rating::new(320, "Twice as clever!"),
        Rating::new(300, "Almost twice as clever."),
        Rating::new(280, "Are you Einstein?"),
        Rating::new(260, "What a genius!"),
        Rating::new(240, "Impressive!"),
        Rating::new(220, "Hats off to you!"),
        Rating::new(200, "Great result!"),
        Rating::new(180, "That was pretty good."),
        Rating::new(160, "Not bad at all."),
        Rating::new(140, "You could do better."),
        Rating::new(Score::MIN, "Half as clever."),
    ];

    /// A new game, round 1, dice already rolled.
    ///
    /// [`Mat::new`] rolls, so the first node is the opening pick rather than a
    /// chance node: rolling again here would burn a roll for nothing.
    pub fn new(rng: &mut impl RngCore) -> Self {
        let mut game = TwiceAsClever {
            round: Round::FIRST,
            phase: Phase::Pick,
            picks: 0,
            mat: Mat::new(rng),
            sheet: Sheet::new(),
            reroll: Bar::new(Self::BAR_SLOTS),
            plus1: Bar::new(Self::BAR_SLOTS),
            ret: Bar::new(Self::BAR_SLOTS),
            plus1_used: DieSet::new(),
            foxes: 0,
            pending: Pending::new(),
            stats: Stats::new(),
        };
        game.grant_round_bonus();
        game.prune();
        game
    }

    /// Where in the round the game stands.
    #[must_use]
    pub const fn phase(&self) -> Phase {
        self.phase
    }

    /// How many dice the active turn has placed.
    #[must_use]
    pub const fn picks(&self) -> u8 {
        self.picks
    }

    /// The dice, their faces and where they sit.
    #[must_use]
    pub const fn mat(&self) -> &Mat<6> {
        &self.mat
    }

    /// The score sheet.
    #[must_use]
    pub const fn sheet(&self) -> &Sheet {
        &self.sheet
    }

    /// The re-roll bar. Filling it grants a fox.
    #[must_use]
    pub const fn reroll_bar(&self) -> &Bar {
        &self.reroll
    }

    /// The +1 bar. Filling it grants a silver `?`.
    #[must_use]
    pub const fn plus1_bar(&self) -> &Bar {
        &self.plus1
    }

    /// The return bar. Filling it grants a pink `?`.
    #[must_use]
    pub const fn return_bar(&self) -> &Bar {
        &self.ret
    }

    /// The dice already spent on a +1 **this round**.
    ///
    /// Cleared on the round advance and nowhere else: this game's +1 scope is
    /// the round, where the base game's is the turn, so a die spent in the
    /// active turn stays spent through the passive one.
    #[must_use]
    pub const fn plus1_used(&self) -> DieSet {
        self.plus1_used
    }

    /// How many foxes have been collected.
    #[must_use]
    pub const fn foxes(&self) -> u8 {
        self.foxes
    }

    /// The decisions waiting to be resolved, head first.
    pub fn pending(&self) -> impl Iterator<Item = Choice> + '_ {
        self.pending.iter()
    }

    /// The value blue is written at: blue + white, whichever die is spent
    /// there and wherever either die currently sits.
    #[must_use]
    pub fn blue_value(&self) -> Pips {
        Pips::of(
            self.mat.face(Color::Blue.die()),
            self.mat.face(Color::White.die()),
        )
    }

    /// The rulebook's label for the score as it stands.
    #[must_use]
    pub fn rating(&self) -> &'static str {
        rate(&Self::RATING, self.sheet.score(self.foxes).total)
    }

    /// Every mark a die can make right now, at its current face.
    #[must_use]
    pub fn die_marks(&self, die: Die) -> DieMarks {
        match Color::of(die) {
            Some(color) => self
                .sheet
                .marks(color, self.mat.face(die), self.blue_value()),
            None => DieMarks::new(),
        }
    }

    /// Fill `out` with the legal actions. The allocation-free form of
    /// [`Solitaire::node`] for a hot loop that reuses one buffer.
    pub fn actions_into(&self, out: &mut Actions<Action>) {
        out.clear();
        if self.phase == Phase::Over {
            return;
        }
        if let Some(head) = self.pending.head() {
            match head {
                Choice::Free(target) => {
                    for place in self.sheet.free(target) {
                        out.push(Action::Bonus(BonusPick::Cell(place)));
                    }
                }
                Choice::SilverRow(value) => {
                    for place in self.sheet.silver_rows(value) {
                        out.push(Action::Bonus(BonusPick::Cell(place)));
                    }
                }
                Choice::Black => {
                    for target in FreeTarget::ALL {
                        if self.sheet.free(target).next().is_some() {
                            out.push(Action::Bonus(BonusPick::Black(target)));
                        }
                    }
                }
            }
            return;
        }
        match self.phase {
            Phase::Roll | Phase::PassiveRoll | Phase::Over => {}
            Phase::PreRoll => self.return_actions(out),
            Phase::Pick => self.pick_actions(out),
            Phase::EndTurn | Phase::PassiveEndTurn => self.end_turn_actions(out),
            Phase::PassivePick => self.passive_pick_actions(out),
        }
    }

    /// The return window. Reached only with a banked return and a non-empty
    /// platter, so there is always at least one return to offer beside
    /// [`Action::Proceed`].
    fn return_actions(&self, out: &mut Actions<Action>) {
        for die in self.mat.platter() {
            out.push(Action::Return { die });
        }
        out.push(Action::Proceed);
    }

    /// The active pick: re-roll, take a die, or — when *no* die can be placed
    /// at all — forfeit the roll.
    ///
    /// A die with no placement is still offered as a wasted pick, **except the
    /// silver die**: with its value marked in all four rows the rulebook says
    /// it cannot be chosen. That ban is a rule about this sheet, and it lives
    /// here rather than in shared code testing a color name.
    fn pick_actions(&self, out: &mut Actions<Action>) {
        if self.reroll.available() > 0 && self.mat.pool().next().is_some() {
            out.push(Action::Reroll);
        }
        let mut any = false;
        for die in self.mat.pool() {
            let marks = self.die_marks(die);
            if marks.is_empty() {
                if Color::of(die) != Some(Color::Silver) {
                    out.push(Action::Pick { die, place: None });
                }
            } else {
                any = true;
                for place in marks {
                    out.push(Action::Pick {
                        die,
                        place: Some(place),
                    });
                }
            }
        }
        if !any {
            out.push(Action::Skip);
        }
    }

    /// The +1 window, at the end of an active or a passive turn: any die not
    /// yet spent this *round*, wherever it sits, at its current face.
    fn end_turn_actions(&self, out: &mut Actions<Action>) {
        if self.plus1.available() > 0 {
            for die in self.mat.dice() {
                if self.plus1_used.contains(die) {
                    continue;
                }
                for place in self.die_marks(die) {
                    out.push(Action::Plus1 { die, place });
                }
            }
        }
        out.push(Action::EndTurn);
    }

    /// The passive pick: one of the three platter dice, or none of them. No
    /// re-roll and no return: both are active-turn actions.
    fn passive_pick_actions(&self, out: &mut Actions<Action>) {
        for die in self.mat.platter() {
            for place in self.die_marks(die) {
                out.push(Action::PassivePick { die, place });
            }
        }
        out.push(Action::PassiveSkip);
    }

    /// Roll the dice a [`Node::Chance`] is waiting on. A no-op elsewhere.
    pub fn roll_dice(&mut self, rng: &mut impl RngCore) {
        match self.phase {
            Phase::Roll => {
                self.mat.roll_pool(rng);
                self.phase = Phase::Pick;
            }
            Phase::PassiveRoll => {
                let _ = self.mat.passive_roll(rng);
                self.phase = Phase::PassivePick;
            }
            _ => debug_assert!(false, "rolled at a decision node"),
        }
    }

    // -- transitions ---------------------------------------------------------

    fn execute(&mut self, action: Action) {
        match action {
            Action::Bonus(pick) => self.resolve(pick),
            Action::Reroll => {
                let spent = self.reroll.spend();
                debug_assert!(spent, "a re-roll was offered with none banked");
                self.stats.rerolls_used += 1;
                self.enter_roll();
            }
            Action::Return { die } => {
                let spent = self.ret.spend();
                debug_assert!(spent, "a return was offered with none banked");
                let recalled = self.mat.recall(die);
                debug_assert!(recalled, "a return was offered for a die off the platter");
                self.stats.returns_used += 1;
                // Stay in the window while both a return and a platter die
                // remain.
                self.enter_roll();
            }
            Action::Proceed => self.phase = Phase::Roll,
            Action::Pick { die, place } => {
                let moved = self.mat.take(die);
                self.picks += 1;
                if let Some(place) = place {
                    self.place(place);
                    if matches!(place, Placement::Silver(_)) {
                        self.platter_chain(moved);
                    }
                }
                self.after_pick();
            }
            Action::Skip => {
                self.picks += 1;
                self.stats.skips += 1;
                self.after_pick();
            }
            Action::Plus1 { die, place } => {
                let spent = self.plus1.spend();
                debug_assert!(spent, "a +1 was offered with none banked");
                self.stats.plus1_spent += 1;
                self.plus1_used.insert(die);
                self.place(place);
            }
            Action::EndTurn => self.end_turn(),
            Action::PassivePick { place, .. } => {
                self.place(place);
                self.phase = Phase::PassiveEndTurn;
            }
            Action::PassiveSkip => self.phase = Phase::PassiveEndTurn,
        }
    }

    /// The platter chain: a pick placed in the silver grid also marks every
    /// die that pick moved onto the platter.
    ///
    /// A colored die marks its own row on the spot, and is lost on the spot if
    /// that cell is taken. The wild and silver dice choose their row, and
    /// those choices go to the **front** of the queue in die order — ahead of
    /// anything the placement itself queued — which is why they are pushed in
    /// reverse.
    ///
    /// `moved` holds only the dice this pick swept up; dice parked on the
    /// platter by an earlier pick are not in it and are not marked.
    fn platter_chain(&mut self, moved: DieSet) {
        for die in moved {
            let Some(row) = Color::of(die).and_then(Color::silver_row) else {
                continue;
            };
            self.fire(Effect::SilverMark(self.mat.face(die), Some(row)), false);
        }
        for die in moved.iter().rev() {
            let Some(color) = Color::of(die) else {
                continue;
            };
            if color.silver_row().is_none() {
                self.fire(Effect::SilverMark(self.mat.face(die), None), true);
            }
        }
    }

    /// Resolve the head of the queue. Taking a black option queues *its* `?`
    /// ahead of everything still waiting.
    fn resolve(&mut self, pick: BonusPick) {
        let Some(head) = self.pending.pop() else {
            return;
        };
        match (head, pick) {
            (Choice::Free(_) | Choice::SilverRow(_), BonusPick::Cell(place)) => self.place(place),
            (Choice::Black, BonusPick::Black(target)) => self.fire(Effect::Free(target), true),
            _ => debug_assert!(false, "a bonus pick that does not match its decision"),
        }
    }

    /// Mark the sheet and resolve the bonus cascade.
    ///
    /// Direct recursion, and it cannot loop: every arm either terminates,
    /// consumes a cell or circles a capped bar, and there are finitely many of
    /// each.
    fn place(&mut self, place: Placement) {
        for effect in self.sheet.apply(place) {
            self.fire(effect, false);
        }
    }

    fn fire(&mut self, effect: Effect, front: bool) {
        match effect {
            Effect::Fox => self.foxes += 1,
            Effect::Reroll => self.unlock(BarKind::Reroll),
            Effect::Plus1 => self.unlock(BarKind::Plus1),
            Effect::Return => self.unlock(BarKind::Return),

            // A chain mark into a fixed row is this sheet's only bonus that is
            // applied at once — and lost at once when the cell is taken.
            Effect::SilverMark(value, Some(row)) => match self.sheet.silver_row(row, value) {
                Some(place) => self.place(place),
                None => self.stats.bonuses_lost += 1,
            },

            // Decisions: queued, or lost when they are already unresolvable.
            Effect::SilverMark(value, None) => self.queue(Choice::SilverRow(value), front),
            Effect::Free(target) => self.queue(Choice::Free(target), front),
            Effect::Black => self.queue(Choice::Black, front),
        }
    }

    /// Circle a bar slot, and fire its end-of-bar bonus when that was the last
    /// one. All three bars carry one, so [`Unlock::Filled`] is a live arm on
    /// every path.
    fn unlock(&mut self, kind: BarKind) {
        let bar = match kind {
            BarKind::Reroll => &mut self.reroll,
            BarKind::Plus1 => &mut self.plus1,
            BarKind::Return => &mut self.ret,
        };
        match bar.unlock() {
            Unlock::Gained => {}
            Unlock::Filled => self.fire(kind.end_bonus(), false),
            Unlock::Overflow => self.stats.bonuses_lost += 1,
        }
    }

    fn queue(&mut self, choice: Choice, front: bool) {
        if !resolvable(&self.sheet, choice) {
            self.stats.bonuses_lost += 1;
            return;
        }
        let queued = if front {
            self.pending.push_front(choice)
        } else {
            self.pending.push_back(choice)
        };
        if queued.is_err() {
            debug_assert!(false, "PENDING is too small for this game's cascades");
            self.stats.bonuses_lost += 1;
        }
    }

    /// Drop decisions that became impossible while they waited, and count
    /// them. Runs after every action, which is the only place the sheet
    /// changes under a queued decision.
    fn prune(&mut self) {
        let TwiceAsClever {
            pending,
            sheet,
            stats,
            ..
        } = self;
        stats.lose_bonuses(pending.retain_resolvable(|c| resolvable(sheet, c)));
    }

    /// Enter the active turn's roll — through the return window first when a
    /// return is banked *and* the platter is non-empty.
    ///
    /// Called after every pick and before every re-roll, and again after each
    /// return, so the window stays open exactly while both conditions hold.
    /// Passive turns never route through here.
    fn enter_roll(&mut self) {
        self.phase = if self.ret.available() > 0 && self.mat.count(Loc::Platter) > 0 {
            Phase::PreRoll
        } else {
            Phase::Roll
        };
    }

    fn after_pick(&mut self) {
        if self.picks >= Self::PICKS_PER_TURN || self.mat.count(Loc::Pool) == 0 {
            self.phase = Phase::EndTurn;
        } else {
            self.enter_roll();
        }
    }

    /// End the active turn (→ the passive turn) or the passive one (→ the next
    /// round, or the end of the game).
    ///
    /// `plus1_used` survives the active → passive transition and is cleared
    /// only on the round advance: on this sheet each die may take one +1 per
    /// *round*.
    fn end_turn(&mut self) {
        if self.phase == Phase::EndTurn {
            self.mat.reset();
            self.phase = Phase::PassiveRoll;
            return;
        }
        if self.round.is_last(Self::ROUNDS) {
            self.phase = Phase::Over;
            return;
        }
        self.round.advance(Self::ROUNDS);
        self.picks = 0;
        self.mat.reset();
        self.plus1_used.clear();
        self.phase = Phase::Roll;
        self.grant_round_bonus();
    }

    fn grant_round_bonus(&mut self) {
        if let Some(effect) = Self::ROUND_BONUS[self.round.index()] {
            self.fire(effect, false);
        }
    }
}

impl Solitaire for TwiceAsClever {
    type Action = Action;

    fn node(&self) -> Node<Action> {
        if self.phase == Phase::Over {
            return Node::Over;
        }
        if self.pending.is_empty() && matches!(self.phase, Phase::Roll | Phase::PassiveRoll) {
            return Node::Chance;
        }
        let mut actions = Actions::new();
        self.actions_into(&mut actions);
        debug_assert!(!actions.is_empty(), "a decision node with no actions");
        Node::Decision(actions)
    }

    fn apply(&mut self, action: Action) -> Result<(), Error> {
        if matches!(action, Action::Bonus(_)) && self.pending.is_empty() {
            return Err(Error::NotADecision);
        }
        let mut legal = Actions::new();
        self.actions_into(&mut legal);
        if !legal.contains(&action) {
            return Err(Error::Illegal);
        }
        self.execute(action);
        self.prune();
        Ok(())
    }

    fn roll(&mut self, rng: &mut dyn RngCore) {
        let mut rng = rng;
        self.roll_dice(&mut rng);
    }

    fn score(&self) -> Breakdown {
        self.sheet.score(self.foxes)
    }

    fn round(&self) -> Round {
        self.round
    }

    fn stats(&self) -> &Stats {
        &self.stats
    }

    fn describe(&self, action: Action) -> impl core::fmt::Display {
        Described::new(self, action)
    }
}

/// Fixture setters for the crate's own tests. Not part of the public API: a
/// facade restoring a saved game rebuilds it through [`TwiceAsClever::new`]
/// and the areas' `from_*` constructors.
#[cfg(test)]
impl TwiceAsClever {
    pub(crate) fn set_face(&mut self, die: Die, face: Face) {
        self.mat.set_face(die, face);
    }

    pub(crate) fn set_sheet(&mut self, sheet: Sheet) {
        self.sheet = sheet;
    }

    pub(crate) fn set_phase(&mut self, phase: Phase) {
        self.phase = phase;
    }

    pub(crate) fn set_loc(&mut self, die: Die, loc: Loc) {
        self.mat.set_loc(die, loc);
    }

    /// Grant a bonus directly, so a fixture can reach a state the dice would
    /// take a whole round to produce.
    pub(crate) fn grant(&mut self, effect: Effect) {
        self.fire(effect, false);
        self.prune();
    }
}

/// `Face::new(v).unwrap()`, for the fixtures below.
#[cfg(test)]
fn face(v: u8) -> Face {
    Face::new(v).expect("a die face")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::area::{
        Area, Blue, Green, LatticeCell, LatticeState, Pink, Silver, SilverCell, SilverRow, Yellow,
    };
    use clever_core::SeedableRng;

    type Rng = rand_xoshiro::Xoshiro256PlusPlus;

    fn rng(seed: u64) -> Rng {
        Rng::seed_from_u64(seed)
    }

    /// A round-1 game in the pick phase with chosen faces, in die order:
    /// white, yellow, blue, green, pink, silver.
    fn picking(faces: [u8; 6]) -> TwiceAsClever {
        let mut game = TwiceAsClever::new(&mut rng(0));
        for (i, v) in faces.into_iter().enumerate() {
            game.mat.set_face(Die::new(i as u8), face(v));
        }
        game.phase = Phase::Pick;
        game
    }

    fn actions(game: &TwiceAsClever) -> Actions<Action> {
        match game.node() {
            Node::Decision(a) => a,
            other => panic!("expected a decision, got {other:?}"),
        }
    }

    /// The silver cell holding `value` in row `row`.
    fn silver(row: usize, value: u8) -> Placement {
        Placement::Silver(SilverCell::at(
            SilverRow::new(row as u8).expect("a row"),
            face(value),
        ))
    }

    /// A lattice mark at a *layout* position — the sheet's own coordinates.
    fn lattice(position: u8) -> Placement {
        Placement::Yellow(LatticeCell::at(position).expect("a real cell"))
    }

    fn pips(v: u8) -> Pips {
        Pips::new(v).expect("a two-die sum")
    }

    fn sheet_with(silver: Silver, yellow: Yellow, blue: Blue, green: Green, pink: Pink) -> Sheet {
        Sheet::from_areas(silver, yellow, blue, green, pink)
    }

    fn blank() -> Sheet {
        Sheet::new()
    }

    /// A sheet with every area full — nothing anywhere can be marked.
    fn full_sheet() -> Sheet {
        let mut yellow = Yellow::new();
        for _ in 0..2 {
            for cell in Yellow::cells() {
                let _ = yellow.apply(cell);
            }
        }
        sheet_with(
            Silver::from_bits(u32::MAX),
            yellow,
            Blue::from_sums(&[pips(2); 12]),
            Green::from_faces(&[face(1); 12]),
            Pink::from_faces(&[face(1); 12]),
        )
    }

    // -- setup ---------------------------------------------------------------

    #[test]
    fn round_one_grants_a_reroll_and_nothing_else() {
        let game = TwiceAsClever::new(&mut rng(1));
        assert_eq!(game.reroll_bar().available(), 1);
        assert_eq!(game.plus1_bar().available(), 0);
        assert_eq!(game.return_bar().available(), 0);
        assert_eq!(game.round(), Round::FIRST);
        // `Mat::new` rolled, so the opening node is the pick, not a roll.
        assert_eq!(game.phase(), Phase::Pick);
        assert!(!game.node().is_chance());
        assert_eq!(game.score().total, 0);
        assert_eq!(game.rating(), "Half as clever.");
    }

    #[test]
    fn every_bar_prints_six_slots_and_ends_in_a_bonus() {
        let game = TwiceAsClever::new(&mut rng(2));
        for bar in [game.reroll_bar(), game.plus1_bar(), game.return_bar()] {
            assert_eq!(bar.cap(), TwiceAsClever::BAR_SLOTS);
        }
        assert_eq!(BarKind::Reroll.end_bonus(), Effect::Fox);
        assert_eq!(BarKind::Plus1.end_bonus(), Effect::Free(FreeTarget::Silver));
        assert_eq!(BarKind::Return.end_bonus(), Effect::Free(FreeTarget::Pink));
    }

    // -- placements ----------------------------------------------------------

    #[test]
    fn only_the_silver_and_white_dice_reach_the_silver_grid() {
        let game = picking([4, 4, 4, 4, 4, 4]);
        for color in [Color::Yellow, Color::Blue, Color::Green, Color::Pink] {
            assert!(
                game.die_marks(color.die())
                    .iter()
                    .all(|p| p.area() != Sheet::SILVER),
                "{color} reaches silver directly"
            );
        }
        for color in [Color::White, Color::Silver] {
            assert!(game
                .die_marks(color.die())
                .iter()
                .any(|p| p.area() == Sheet::SILVER));
        }
    }

    #[test]
    fn a_silver_die_marks_its_value_in_any_open_row() {
        let game = picking([1, 1, 1, 1, 1, 4]);
        let cells: Vec<Placement> = game.die_marks(Color::Silver.die()).into_iter().collect();
        assert_eq!(
            cells,
            vec![silver(0, 4), silver(1, 4), silver(2, 4), silver(3, 4)]
        );
    }

    #[test]
    fn a_yellow_die_circles_then_crosses_its_lattice_cells() {
        let mut game = picking([1, 5, 1, 1, 1, 1]);
        let cells: Vec<Placement> = game.die_marks(Color::Yellow.die()).into_iter().collect();
        assert_eq!(cells, vec![lattice(14), lattice(17)]);
        game.apply(Action::Pick {
            die: Color::Yellow.die(),
            place: Some(lattice(14)),
        })
        .unwrap();
        let Placement::Yellow(cell) = lattice(14) else {
            panic!("a yellow mark")
        };
        assert_eq!(game.sheet().yellow().state(cell), LatticeState::Circled);
        // The same cell is offered again — this time the mark crosses it.
        assert!(game.die_marks(Color::Yellow.die()).contains(&lattice(14)));
    }

    #[test]
    fn blue_writes_blue_plus_white_whichever_die_is_placed() {
        let game = picking([3, 1, 4, 1, 1, 1]);
        assert_eq!(game.blue_value(), pips(7));
        for color in [Color::Blue, Color::White] {
            let from: Vec<Placement> = game
                .die_marks(color.die())
                .into_iter()
                .filter(|p| p.area() == Sheet::BLUE)
                .collect();
            assert_eq!(from, vec![Placement::Blue(pips(7))], "{color}");
        }
    }

    #[test]
    fn blue_writes_must_not_increase() {
        let mut game = picking([3, 1, 5, 1, 1, 1]); // blue + white = 8
        game.sheet = sheet_with(
            Silver::new(),
            Yellow::new(),
            Blue::from_sums(&[pips(7)]),
            Green::new(),
            Pink::new(),
        );
        assert_eq!(game.die_marks(Color::Blue.die()).len(), 0, "8 is above 7");
        game.mat.set_face(Color::Blue.die(), face(4)); // 4 + 3 = 7
        assert_eq!(
            game.die_marks(Color::Blue.die()).as_slice(),
            &[Placement::Blue(pips(7))],
            "equal is legal"
        );
    }

    #[test]
    fn green_stores_the_face_and_multiplies_when_scoring() {
        let mut game = picking([1, 1, 1, 4, 1, 1]);
        assert_eq!(
            game.die_marks(Color::Green.die()).as_slice(),
            &[Placement::Green(face(4))]
        );
        game.apply(Action::Pick {
            die: Color::Green.die(),
            place: Some(Placement::Green(face(4))),
        })
        .unwrap();
        assert_eq!(game.sheet().green().faces(), &[face(4)]);
        assert_eq!(game.sheet().green().written(0), Some(8), "slot 1 is ×2");
    }

    #[test]
    fn pink_takes_any_face_and_gates_only_the_bonus() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.sheet = sheet_with(
            Silver::new(),
            Yellow::new(),
            Blue::new(),
            Green::new(),
            // Slot 3 grants a re-roll, gated on a 2.
            Pink::from_faces(&[face(3), face(3)]),
        );
        let before = game.reroll_bar().circled();
        game.apply(Action::Pick {
            die: Color::Pink.die(),
            place: Some(Placement::Pink(face(1))),
        })
        .unwrap();
        assert_eq!(game.sheet().pink().faces().len(), 3, "the slot is filled");
        assert_eq!(game.reroll_bar().circled(), before, "the bonus is withheld");
    }

    // -- the platter chain ---------------------------------------------------

    #[test]
    fn colored_dice_moved_by_a_silver_pick_mark_their_own_rows() {
        // Pick silver 4: yellow (2) and blue (3) move; the rest are ≥ 4.
        let mut game = picking([6, 2, 3, 5, 6, 4]);
        game.apply(Action::Pick {
            die: Color::Silver.die(),
            place: Some(silver(0, 4)),
        })
        .unwrap();
        let grid = game.sheet().silver();
        assert!(grid.is_marked(SilverCell::at(SilverRow::Yellow, face(2))));
        assert!(grid.is_marked(SilverCell::at(SilverRow::Blue, face(3))));
        assert_eq!(grid.marked(), 3, "the pick and the two chain marks");
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.stats().bonuses_lost, 0);
        assert_eq!(game.phase(), Phase::Roll, "no return banked, no window");
    }

    #[test]
    fn a_moved_wild_die_queues_a_row_choice_and_the_fixed_rows_apply_first() {
        // Pick silver 5: white (2) chooses a row, yellow (3) and blue (4) do
        // not.
        let mut game = picking([2, 3, 4, 6, 6, 5]);
        game.apply(Action::Pick {
            die: Color::Silver.die(),
            place: Some(silver(2, 5)),
        })
        .unwrap();
        let grid = game.sheet().silver();
        assert!(grid.is_marked(SilverCell::at(SilverRow::Yellow, face(3))));
        assert!(grid.is_marked(SilverCell::at(SilverRow::Blue, face(4))));
        assert_eq!(
            game.pending().collect::<Vec<_>>(),
            vec![Choice::SilverRow(face(2))]
        );
        let list = actions(&game);
        assert_eq!(list.len(), 4, "value 2 is open in all four rows");
        game.apply(Action::Bonus(BonusPick::Cell(silver(2, 2))))
            .unwrap();
        assert!(game
            .sheet()
            .silver()
            .is_marked(SilverCell::at(SilverRow::Green, face(2))));
        assert_eq!(game.pending().count(), 0);
    }

    #[test]
    fn a_moved_silver_die_chooses_its_row_too() {
        // The white die placed as silver 4; the silver die (2) is swept up.
        let mut game = picking([4, 6, 6, 6, 6, 2]);
        game.apply(Action::Pick {
            die: Color::White.die(),
            place: Some(silver(0, 4)),
        })
        .unwrap();
        assert_eq!(
            game.pending().collect::<Vec<_>>(),
            vec![Choice::SilverRow(face(2))]
        );
    }

    #[test]
    fn a_chain_mark_whose_row_is_taken_is_lost_never_queued() {
        let mut game = picking([5, 2, 5, 5, 5, 4]);
        game.sheet = sheet_with(
            Silver::from_bits(1 << SilverCell::at(SilverRow::Yellow, face(2)).index()),
            Yellow::new(),
            Blue::new(),
            Green::new(),
            Pink::new(),
        );
        game.apply(Action::Pick {
            die: Color::Silver.die(),
            place: Some(silver(1, 4)),
        })
        .unwrap();
        assert_eq!(game.stats().bonuses_lost, 1);
        assert_eq!(game.pending().count(), 0);
    }

    #[test]
    fn only_dice_moved_by_this_pick_are_marked() {
        let mut game = picking([6, 2, 3, 1, 6, 4]);
        game.mat.set_loc(Color::Green.die(), Loc::Platter);
        game.apply(Action::Pick {
            die: Color::Silver.die(),
            place: Some(silver(3, 4)),
        })
        .unwrap();
        let grid = game.sheet().silver();
        assert!(grid.is_marked(SilverCell::at(SilverRow::Yellow, face(2))));
        assert!(grid.is_marked(SilverCell::at(SilverRow::Blue, face(3))));
        assert!(
            !grid.is_marked(SilverCell::at(SilverRow::Green, face(1))),
            "green was already parked on the platter"
        );
        assert_eq!(game.pending().count(), 0);
    }

    #[test]
    fn row_choices_resolve_before_the_picks_own_bonuses() {
        // The placement completes column 4 — a blue `?` — while the moved
        // silver die still owes a row choice. The choice comes first.
        let mut game = picking([4, 6, 6, 6, 6, 2]);
        let mut grid = Silver::new();
        for row in 0..3 {
            let _ = grid.apply(SilverCell::at(SilverRow::new(row).expect("a row"), face(4)));
        }
        game.sheet = sheet_with(grid, Yellow::new(), Blue::new(), Green::new(), Pink::new());
        game.apply(Action::Pick {
            die: Color::White.die(),
            place: Some(silver(3, 4)),
        })
        .unwrap();
        assert_eq!(
            game.pending().collect::<Vec<_>>(),
            vec![Choice::SilverRow(face(2)), Choice::Free(FreeTarget::Blue)]
        );
        game.apply(Action::Bonus(BonusPick::Cell(silver(0, 2))))
            .unwrap();
        assert_eq!(
            game.pending().collect::<Vec<_>>(),
            vec![Choice::Free(FreeTarget::Blue)]
        );
    }

    #[test]
    fn a_pick_into_any_other_area_starts_no_chain() {
        let mut game = picking([1, 3, 6, 6, 6, 2]);
        game.apply(Action::Pick {
            die: Color::Yellow.die(),
            place: Some(lattice(1)),
        })
        .unwrap();
        assert_eq!(game.mat().loc(Color::White.die()), Loc::Platter);
        assert_eq!(game.mat().loc(Color::Silver.die()), Loc::Platter);
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.sheet().silver().marked(), 0);
    }

    #[test]
    fn a_passive_pick_into_silver_starts_no_chain() {
        let mut game = picking([3, 2, 6, 6, 6, 4]);
        for (die, loc) in [
            (Color::White.die(), Loc::Platter),
            (Color::Yellow.die(), Loc::Platter),
            (Color::Silver.die(), Loc::Platter),
        ] {
            game.mat.set_loc(die, loc);
        }
        game.phase = Phase::PassivePick;
        game.apply(Action::PassivePick {
            die: Color::Silver.die(),
            place: silver(0, 4),
        })
        .unwrap();
        assert_eq!(game.phase(), Phase::PassiveEndTurn);
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.sheet().silver().marked(), 1, "only the pick itself");
    }

    #[test]
    fn a_plus_one_into_silver_starts_no_chain() {
        let mut game = picking([3, 2, 6, 6, 6, 4]);
        game.fire(Effect::Plus1, false);
        game.mat.set_loc(Color::White.die(), Loc::Platter);
        game.phase = Phase::EndTurn;
        game.apply(Action::Plus1 {
            die: Color::Silver.die(),
            place: silver(1, 4),
        })
        .unwrap();
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.sheet().silver().marked(), 1);
        assert!(game.plus1_used().contains(Color::Silver.die()));
    }

    // -- the silver-die pick ban ---------------------------------------------

    #[test]
    fn a_silver_die_whose_value_is_exhausted_is_not_offered_at_all() {
        let mut game = picking([6, 1, 6, 6, 6, 3]);
        let mut grid = Silver::new();
        for row in SilverRow::ALL {
            let _ = grid.apply(SilverCell::at(row, face(3)));
        }
        game.sheet = sheet_with(grid, Yellow::new(), Blue::new(), Green::new(), Pink::new());
        for die in [
            Color::White.die(),
            Color::Blue.die(),
            Color::Green.die(),
            Color::Pink.die(),
        ] {
            game.mat.set_loc(die, Loc::Field);
        }
        let list = actions(&game);
        assert!(
            !list.iter().any(|a| a.die() == Some(Color::Silver.die())),
            "{list:?}"
        );
        assert!(list
            .iter()
            .any(|a| matches!(a, Action::Pick { place: Some(_), .. })));
        assert!(!list.contains(&Action::Skip), "yellow can still be placed");
    }

    #[test]
    fn every_other_die_keeps_its_wasted_pick() {
        let mut game = picking([6, 1, 6, 6, 6, 3]);
        let mut grid = Silver::new();
        for row in SilverRow::ALL {
            let _ = grid.apply(SilverCell::at(row, face(3)));
        }
        // Cross the lattice's only 1, so the yellow die has nothing either.
        let mut yellow = Yellow::new();
        let one = LatticeCell::at(4).expect("the lone 1");
        let _ = yellow.apply(one);
        let _ = yellow.apply(one);
        game.sheet = sheet_with(grid, yellow, Blue::new(), Green::new(), Pink::new());
        for die in [
            Color::White.die(),
            Color::Blue.die(),
            Color::Green.die(),
            Color::Pink.die(),
        ] {
            game.mat.set_loc(die, Loc::Field);
        }
        let list = actions(&game);
        assert!(list.contains(&Action::Pick {
            die: Color::Yellow.die(),
            place: None
        }));
        assert!(!list.iter().any(|a| a.die() == Some(Color::Silver.die())));
        assert!(list.contains(&Action::Skip), "no die can be placed");
    }

    // -- the return window ---------------------------------------------------

    #[test]
    fn the_window_opens_after_a_pick_when_a_return_and_a_platter_die_exist() {
        let mut game = picking([1, 3, 6, 6, 6, 6]);
        game.fire(Effect::Return, false);
        game.apply(Action::Pick {
            die: Color::Yellow.die(),
            place: Some(lattice(1)),
        })
        .unwrap();
        assert_eq!(game.phase(), Phase::PreRoll);
        assert_eq!(
            actions(&game).as_ref(),
            &[
                Action::Return {
                    die: Color::White.die()
                },
                Action::Proceed
            ]
        );
        game.apply(Action::Return {
            die: Color::White.die(),
        })
        .unwrap();
        assert_eq!(game.mat().loc(Color::White.die()), Loc::Pool);
        assert_eq!(game.return_bar().available(), 0);
        assert_eq!(game.stats().returns_used, 1);
        assert_eq!(game.phase(), Phase::Roll, "no returns left");
    }

    #[test]
    fn the_window_stays_open_while_returns_and_platter_dice_remain() {
        let mut game = picking([1, 3, 2, 6, 6, 6]);
        game.fire(Effect::Return, false);
        game.fire(Effect::Return, false);
        game.apply(Action::Pick {
            die: Color::Yellow.die(),
            place: Some(lattice(1)),
        })
        .unwrap();
        assert_eq!(
            actions(&game).as_ref(),
            &[
                Action::Return {
                    die: Color::White.die()
                },
                Action::Return {
                    die: Color::Blue.die()
                },
                Action::Proceed
            ]
        );
        game.apply(Action::Return {
            die: Color::White.die(),
        })
        .unwrap();
        assert_eq!(game.phase(), Phase::PreRoll, "one return and blue remain");
        game.apply(Action::Proceed).unwrap();
        assert_eq!(game.phase(), Phase::Roll);
        assert_eq!(game.return_bar().available(), 1, "proceed spends nothing");
    }

    #[test]
    fn the_window_opens_before_a_reroll_so_a_returned_die_joins_it() {
        let mut game = picking([4, 4, 4, 4, 4, 4]);
        game.fire(Effect::Return, false);
        game.mat.set_loc(Color::White.die(), Loc::Platter);
        game.apply(Action::Reroll).unwrap();
        assert_eq!(game.phase(), Phase::PreRoll);
        game.apply(Action::Return {
            die: Color::White.die(),
        })
        .unwrap();
        assert_eq!(game.mat().loc(Color::White.die()), Loc::Pool);
        assert_eq!(game.phase(), Phase::Roll);
    }

    #[test]
    fn the_window_does_not_open_with_an_empty_platter() {
        let mut game = picking([6, 1, 6, 6, 6, 6]);
        game.fire(Effect::Return, false);
        game.apply(Action::Pick {
            die: Color::Yellow.die(),
            place: Some(lattice(4)),
        })
        .unwrap();
        assert_eq!(game.phase(), Phase::Roll, "nothing moved");
    }

    #[test]
    fn the_window_never_opens_on_a_passive_turn() {
        let mut game = picking([1, 2, 3, 4, 5, 6]);
        for _ in 0..3 {
            game.fire(Effect::Return, false);
        }
        game.phase = Phase::EndTurn;
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.phase(), Phase::PassiveRoll);
        game.roll_dice(&mut rng(7));
        assert_eq!(game.phase(), Phase::PassivePick);
        assert_eq!(game.mat().count(Loc::Platter), 3);
        assert!(!actions(&game)
            .iter()
            .any(|a| matches!(a, Action::Return { .. })));
        game.apply(Action::PassiveSkip).unwrap();
        assert_eq!(game.phase(), Phase::PassiveEndTurn);
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.round().get(), 2);
        assert_eq!(
            game.phase(),
            Phase::Roll,
            "the round start clears the platter"
        );
    }

    // -- the action bars -----------------------------------------------------

    #[test]
    fn an_unlock_past_a_full_bar_is_lost_and_does_not_refire_the_end_bonus() {
        let mut game = picking([3, 3, 3, 3, 5, 3]);
        game.sheet = sheet_with(
            Silver::new(),
            Yellow::new(),
            Blue::new(),
            Green::new(),
            Pink::from_faces(&[face(5), face(5)]),
        );
        for _ in game.reroll_bar().circled()..TwiceAsClever::BAR_SLOTS {
            game.fire(Effect::Reroll, false);
        }
        assert!(game.reroll_bar().is_full());
        let foxes = game.foxes();
        let lost = game.stats().bonuses_lost;
        let banked = game.reroll_bar().available();
        // Pink slot 3 grants a re-roll, and the bar has no slot left.
        game.apply(Action::Pick {
            die: Color::Pink.die(),
            place: Some(Placement::Pink(face(5))),
        })
        .unwrap();
        assert_eq!(game.stats().bonuses_lost, lost + 1);
        assert_eq!(game.reroll_bar().available(), banked);
        assert_eq!(game.reroll_bar().circled(), TwiceAsClever::BAR_SLOTS);
        assert_eq!(game.foxes(), foxes, "the end bonus does not re-fire");
    }

    #[test]
    fn circling_the_last_slot_fires_the_end_bonus_exactly_then() {
        let mut game = picking([3, 3, 3, 3, 5, 3]);
        game.sheet = sheet_with(
            Silver::new(),
            Yellow::new(),
            Blue::new(),
            Green::new(),
            Pink::from_faces(&[face(5), face(5)]),
        );
        // Round 1 circled one slot; take the bar to one short of full.
        while game.reroll_bar().circled() < TwiceAsClever::BAR_SLOTS - 1 {
            game.fire(Effect::Reroll, false);
        }
        assert_eq!(game.foxes(), 0);
        game.apply(Action::Pick {
            die: Color::Pink.die(),
            place: Some(Placement::Pink(face(5))),
        })
        .unwrap();
        assert_eq!(game.reroll_bar().circled(), TwiceAsClever::BAR_SLOTS);
        assert_eq!(
            game.reroll_bar().available(),
            TwiceAsClever::BAR_SLOTS,
            "the capping unlock still banks its action"
        );
        assert_eq!(game.foxes(), 1, "the re-roll bar ends in a fox");
        assert_eq!(game.stats().bonuses_lost, 0);
    }

    #[test]
    fn the_return_bar_unlocks_returns_and_ends_in_a_pink_question() {
        let mut game = picking([3, 3, 3, 3, 3, 3]);
        game.sheet = sheet_with(
            Silver::new(),
            Yellow::new(),
            Blue::new(),
            Green::new(),
            Pink::from_faces(&[face(5), face(5), face(5)]),
        );
        for _ in 0..TwiceAsClever::BAR_SLOTS - 1 {
            game.fire(Effect::Return, false);
        }
        // Pink slot 4 grants a return, gated on a 3 — the sixth slot.
        game.apply(Action::Pick {
            die: Color::Pink.die(),
            place: Some(Placement::Pink(face(3))),
        })
        .unwrap();
        assert_eq!(game.return_bar().available(), TwiceAsClever::BAR_SLOTS);
        assert!(game.return_bar().is_full());
        assert_eq!(
            game.pending().collect::<Vec<_>>(),
            vec![Choice::Free(FreeTarget::Pink)]
        );
        let list = actions(&game);
        assert_eq!(list.len(), 6, "six faces at pink's next slot");
        game.apply(Action::Bonus(BonusPick::Cell(Placement::Pink(face(1)))))
            .unwrap();
        assert_eq!(game.sheet().pink().faces().len(), 5);
        assert_eq!(game.plus1_bar().circled(), 0, "1 is below slot 5's gate");
    }

    #[test]
    fn the_plus_one_bar_ends_in_a_silver_question() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        for _ in 0..TwiceAsClever::BAR_SLOTS {
            game.fire(Effect::Plus1, false);
        }
        assert!(game.plus1_bar().is_full());
        assert_eq!(
            game.pending().collect::<Vec<_>>(),
            vec![Choice::Free(FreeTarget::Silver)]
        );
        assert_eq!(actions(&game).len(), 24, "every silver cell is open");
    }

    // -- the +1 window -------------------------------------------------------

    #[test]
    fn a_plus_one_takes_any_die_wherever_it_sits() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.fire(Effect::Plus1, false);
        game.mat.set_loc(Color::Pink.die(), Loc::Platter);
        game.mat.set_loc(Color::Green.die(), Loc::Field);
        game.phase = Phase::EndTurn;
        let list = actions(&game);
        for die in game.mat().dice() {
            assert!(
                list.iter().any(|a| a.die() == Some(die)),
                "{die} is out of the +1 window"
            );
        }
        game.apply(Action::Plus1 {
            die: Color::Pink.die(),
            place: Placement::Pink(face(1)),
        })
        .unwrap();
        assert_eq!(game.stats().plus1_spent, 1);
        assert!(game.plus1_used().contains(Color::Pink.die()));
        assert_eq!(game.phase(), Phase::EndTurn, "the window stays open");
        assert_eq!(actions(&game).as_ref(), &[Action::EndTurn]);
    }

    #[test]
    fn plus_one_flags_survive_the_passive_turn_and_reset_with_the_round() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.fire(Effect::Plus1, false);
        game.phase = Phase::EndTurn;
        game.apply(Action::Plus1 {
            die: Color::Green.die(),
            place: Placement::Green(face(1)),
        })
        .unwrap();
        assert!(game.plus1_used().contains(Color::Green.die()));
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.phase(), Phase::PassiveRoll);
        assert!(
            game.plus1_used().contains(Color::Green.die()),
            "this game's scope is the round"
        );
        game.phase = Phase::PassiveEndTurn;
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.round().get(), 2);
        assert!(game.plus1_used().is_empty());
    }

    // -- colored ? bonuses ---------------------------------------------------

    #[test]
    fn a_yellow_question_offers_every_circle_and_every_cross() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.fire(Effect::Free(FreeTarget::Yellow), false);
        assert_eq!(actions(&game).len(), 10, "ten circles");
        game.apply(Action::Bonus(BonusPick::Cell(lattice(4))))
            .unwrap();
        let Placement::Yellow(cell) = lattice(4) else {
            panic!("a yellow mark")
        };
        assert_eq!(game.sheet().yellow().state(cell), LatticeState::Circled);
        game.fire(Effect::Free(FreeTarget::Yellow), false);
        let list = actions(&game);
        assert_eq!(list.len(), 10, "nine circles and one cross");
        assert!(list.contains(&Action::Bonus(BonusPick::Cell(lattice(4)))));
        game.apply(Action::Bonus(BonusPick::Cell(lattice(4))))
            .unwrap();
        assert_eq!(game.sheet().yellow().state(cell), LatticeState::Crossed);
    }

    #[test]
    fn a_blue_question_respects_the_descent_and_chains_its_slot_bonus() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.sheet = sheet_with(
            Silver::new(),
            Yellow::new(),
            Blue::from_sums(&[pips(5)]),
            Green::new(),
            Pink::new(),
        );
        game.fire(Effect::Free(FreeTarget::Blue), false);
        let offered: Vec<u8> = actions(&game)
            .iter()
            .filter_map(|a| match a.placement() {
                Some(Placement::Blue(p)) => Some(p.get()),
                _ => None,
            })
            .collect();
        assert_eq!(offered, vec![2, 3, 4, 5]);
        game.apply(Action::Bonus(BonusPick::Cell(Placement::Blue(pips(5)))))
            .unwrap();
        assert_eq!(game.sheet().blue().sums(), &[pips(5), pips(5)]);
        assert_eq!(
            game.return_bar().circled(),
            1,
            "blue slot 2 grants a return"
        );
    }

    #[test]
    fn the_black_question_expands_into_the_colored_one_it_chooses() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.sheet = sheet_with(
            Silver::new(),
            Yellow::new(),
            Blue::new(),
            Green::from_faces(&[face(1); 12]),
            Pink::new(),
        );
        game.fire(Effect::Black, false);
        let list = actions(&game);
        assert_eq!(
            list.iter().copied().collect::<Vec<_>>(),
            vec![
                Action::Bonus(BonusPick::Black(FreeTarget::Silver)),
                Action::Bonus(BonusPick::Black(FreeTarget::Yellow)),
                Action::Bonus(BonusPick::Black(FreeTarget::Blue)),
                Action::Bonus(BonusPick::Black(FreeTarget::Pink)),
            ],
            "a full green area is not offered"
        );
        game.apply(Action::Bonus(BonusPick::Black(FreeTarget::Blue)))
            .unwrap();
        assert_eq!(
            game.pending().collect::<Vec<_>>(),
            vec![Choice::Free(FreeTarget::Blue)]
        );
        game.apply(Action::Bonus(BonusPick::Cell(Placement::Blue(pips(12)))))
            .unwrap();
        assert_eq!(game.sheet().blue().sums(), &[pips(12)]);
        assert_eq!(game.pending().count(), 0);
    }

    #[test]
    fn round_four_grants_the_black_question() {
        let mut game = TwiceAsClever::new(&mut rng(5));
        game.round = Round::new(3).unwrap();
        game.phase = Phase::PassiveEndTurn;
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.round().get(), 4);
        assert_eq!(actions(&game).len(), 5, "five colored ?s");
    }

    #[test]
    fn the_round_track_grants_a_reroll_a_plus_one_and_a_return() {
        let mut game = TwiceAsClever::new(&mut rng(6));
        assert_eq!(game.reroll_bar().circled(), 1);
        for round in 2..=3 {
            game.phase = Phase::PassiveEndTurn;
            game.apply(Action::EndTurn).unwrap();
            assert_eq!(game.round().get(), round);
        }
        assert_eq!(game.plus1_bar().circled(), 1);
        assert_eq!(game.return_bar().circled(), 1);
    }

    #[test]
    fn a_queued_question_that_becomes_impossible_is_lost_and_counted() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        game.sheet = sheet_with(
            Silver::new(),
            Yellow::new(),
            Blue::new(),
            Green::new(),
            Pink::from_faces(&[face(1); 11]),
        );
        game.fire(Effect::Free(FreeTarget::Pink), false);
        game.fire(Effect::Free(FreeTarget::Pink), false);
        assert_eq!(game.pending().count(), 2);
        game.apply(Action::Bonus(BonusPick::Cell(Placement::Pink(face(1)))))
            .unwrap();
        assert_eq!(game.pending().count(), 0, "pink is full under the second");
        assert_eq!(game.stats().bonuses_lost, 1);
    }

    #[test]
    fn a_queued_row_choice_that_becomes_impossible_is_lost_too() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        let mut grid = Silver::new();
        for row in 0..3 {
            let _ = grid.apply(SilverCell::at(SilverRow::new(row).expect("a row"), face(3)));
        }
        game.sheet = sheet_with(grid, Yellow::new(), Blue::new(), Green::new(), Pink::new());
        game.fire(Effect::SilverMark(face(3), None), false);
        game.fire(Effect::SilverMark(face(3), None), false);
        assert_eq!(game.pending().count(), 2);
        assert_eq!(actions(&game).len(), 1, "one row of the value is left");
        game.apply(Action::Bonus(BonusPick::Cell(silver(3, 3))))
            .unwrap();
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.stats().bonuses_lost, 1);
        assert_eq!(game.foxes(), 1, "completing column 3 grants a fox");
    }

    #[test]
    fn a_round_bonus_with_nowhere_to_go_is_lost() {
        let mut game = TwiceAsClever::new(&mut rng(8));
        game.round = Round::new(3).unwrap();
        game.phase = Phase::PassiveEndTurn;
        game.sheet = full_sheet();
        let lost = game.stats().bonuses_lost;
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.round().get(), 4);
        assert_eq!(game.pending().count(), 0);
        assert_eq!(game.stats().bonuses_lost, lost + 1);
    }

    // -- round flow ----------------------------------------------------------

    #[test]
    fn active_then_passive_then_the_next_round() {
        let mut game = TwiceAsClever::new(&mut rng(42));
        game.sheet = full_sheet();
        game.pending.clear();
        for _ in 0..3 {
            let list = actions(&game);
            assert!(list.contains(&Action::Skip), "{list:?}");
            game.apply(Action::Skip).unwrap();
            if game.phase() == Phase::Roll {
                game.roll_dice(&mut rng(7));
            }
        }
        assert_eq!(game.phase(), Phase::EndTurn);
        assert_eq!(game.stats().skips, 3);
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.phase(), Phase::PassiveRoll);
        assert!(game.node().is_chance());

        game.roll_dice(&mut rng(11));
        assert_eq!(game.phase(), Phase::PassivePick);
        let highest = game
            .mat()
            .platter()
            .map(|d| game.mat().face(d))
            .max()
            .unwrap();
        let lowest = game.mat().pool().map(|d| game.mat().face(d)).min().unwrap();
        assert!(highest <= lowest, "the platter holds the three lowest");

        game.apply(Action::PassiveSkip).unwrap();
        assert_eq!(game.phase(), Phase::PassiveEndTurn);
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.round().get(), 2);
        assert_eq!(game.picks(), 0, "picks reset on the round advance");
    }

    #[test]
    fn a_reroll_spends_the_action_and_returns_to_the_roll() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        assert_eq!(game.reroll_bar().available(), 1);
        game.apply(Action::Reroll).unwrap();
        assert_eq!(game.reroll_bar().available(), 0);
        assert_eq!(game.stats().rerolls_used, 1);
        assert_eq!(game.phase(), Phase::Roll);
        assert_eq!(game.picks(), 0, "a re-roll is not a pick");
        game.roll_dice(&mut rng(9));
        assert!(!actions(&game).contains(&Action::Reroll));
    }

    #[test]
    fn the_turn_ends_early_when_no_dice_remain() {
        let mut game = picking([1, 1, 1, 1, 1, 6]);
        game.apply(Action::Pick {
            die: Color::Silver.die(),
            place: Some(silver(0, 6)),
        })
        .unwrap();
        assert_eq!(game.phase(), Phase::EndTurn, "everything else was lower");
    }

    #[test]
    fn the_game_ends_after_the_passive_turn_of_round_six() {
        let mut game = TwiceAsClever::new(&mut rng(14));
        game.round = Round::new(6).unwrap();
        game.phase = Phase::PassiveEndTurn;
        game.apply(Action::EndTurn).unwrap();
        assert_eq!(game.phase(), Phase::Over);
        assert!(game.node().is_over());
        assert_eq!(game.apply(Action::EndTurn), Err(Error::Illegal));
    }

    // -- scoring -------------------------------------------------------------

    #[test]
    fn scoring_matches_the_rulebook_tables_with_a_negative_green() {
        let mut game = TwiceAsClever::new(&mut rng(11));
        let mut grid = Silver::new();
        for value in 1..=4u8 {
            let _ = grid.apply(SilverCell::at(SilverRow::Yellow, face(value)));
        }
        let mut yellow = Yellow::new();
        for position in [1u8, 3] {
            let cell = LatticeCell::at(position).expect("a real cell");
            let _ = yellow.apply(cell);
            let _ = yellow.apply(cell);
        }
        game.sheet = sheet_with(
            grid,
            yellow,
            Blue::from_sums(&[pips(10), pips(9), pips(6)]),
            Green::from_faces(&[face(2), face(3)]), // 4 − 6
            Pink::from_faces(&[face(5), face(3)]),
        );
        game.foxes = 2;
        let b = game.score();
        assert_eq!(b.area(Sheet::SILVER), Some(11));
        assert_eq!(b.area(Sheet::YELLOW), Some(10));
        assert_eq!(b.area(Sheet::BLUE), Some(6));
        assert_eq!(b.area(Sheet::GREEN), Some(-2));
        assert_eq!(b.area(Sheet::PINK), Some(8));
        assert_eq!(b.min_area, -2);
        assert_eq!(b.fox_points, -4, "a negative area drags the foxes down");
        assert_eq!(b.total, 11 + 10 + 6 - 2 + 8 - 4);
    }

    #[test]
    fn the_rating_bands_run_from_140_to_320() {
        let mins: Vec<Score> = TwiceAsClever::RATING.iter().map(|r| r.min).collect();
        assert_eq!(
            mins,
            vec![320, 300, 280, 260, 240, 220, 200, 180, 160, 140, Score::MIN]
        );
        assert_eq!(rate(&TwiceAsClever::RATING, 139), "Half as clever.");
        assert_ne!(rate(&TwiceAsClever::RATING, 140), "Half as clever.");
        assert_eq!(
            rate(&TwiceAsClever::RATING, 319),
            rate(&TwiceAsClever::RATING, 300)
        );
        assert_eq!(rate(&TwiceAsClever::RATING, 320), "Twice as clever!");
    }

    #[test]
    fn foxes_are_worthless_while_an_area_is_empty() {
        let mut game = TwiceAsClever::new(&mut rng(12));
        game.foxes = 5;
        assert_eq!(game.score().fox_points, 0);
        assert_eq!(blank().subtotal(), 0);
    }

    // -- the contract --------------------------------------------------------

    #[test]
    fn an_action_that_was_never_offered_is_rejected() {
        let mut game = picking([1, 1, 1, 1, 1, 1]);
        assert_eq!(
            game.apply(Action::Plus1 {
                die: Color::Pink.die(),
                place: Placement::Pink(face(1)),
            }),
            Err(Error::Illegal),
            "no +1 is banked"
        );
        assert_eq!(
            game.apply(Action::Bonus(BonusPick::Black(FreeTarget::Blue))),
            Err(Error::NotADecision)
        );
        assert_eq!(game.apply(Action::PassiveSkip), Err(Error::Illegal));
        assert_eq!(
            game.apply(Action::Return {
                die: Color::White.die()
            }),
            Err(Error::Illegal),
            "no return window is open"
        );
    }

    #[test]
    fn rolling_at_a_decision_node_changes_nothing() {
        let game = picking([1, 2, 3, 4, 5, 6]);
        let mut same = game.clone();
        // Debug builds assert; this is the release contract.
        if !cfg!(debug_assertions) {
            same.roll_dice(&mut rng(13));
            assert_eq!(same, game);
        }
    }
}
