//! The invariants a game rests on, and the two constants that are measured
//! rather than guessed.
//!
//! Run with `cargo test -p clever-pretty --release -- --nocapture` to see the
//! measurements printed.

use clever_core::{below, Node, Rng, SeedableRng, Solitaire, MAX_ACTIONS};
use clever_pretty::{Action, PrettyClever, PENDING};
use proptest::prelude::*;

/// How many games the measurements and the mean are taken over.
const GAMES: u64 = 20_000;

/// A game cannot possibly need more decisions than this. Six rounds of three
/// picks, a +1 window and a bonus cascade do not come close.
const DECISION_LIMIT: usize = 1_000;

/// What one uniform-random game produced.
struct Run {
    score: i32,
    decisions: usize,
    /// The widest action list the game offered.
    widest: usize,
    /// The deepest the pending queue ever got.
    deepest: usize,
    /// The index chosen at each decision, in order — a replay script.
    script: Vec<usize>,
}

/// The generator the *policy* draws from, kept apart from the one the game's
/// chance nodes draw from so that a recorded script replays against the same
/// dice.
fn policy_rng(seed: u64) -> Rng {
    Rng::seed_from_u64(seed ^ 0x9E37_79B9_7F4A_7C15)
}

/// Play one game with a uniform-random policy over the enumerated actions.
fn play(seed: u64) -> Run {
    let mut dice = Rng::seed_from_u64(seed);
    let mut policy = policy_rng(seed);
    let mut game = PrettyClever::new(&mut dice);
    let mut run = Run {
        score: 0,
        decisions: 0,
        widest: 0,
        deepest: game.pending().count(),
        script: Vec::new(),
    };

    loop {
        assert!(run.decisions < DECISION_LIMIT, "the game did not terminate");
        run.deepest = run.deepest.max(game.pending().count());
        match game.node() {
            Node::Over => break,
            Node::Chance => game.roll(&mut dice),
            Node::Decision(actions) => {
                assert!(!actions.is_empty(), "a decision node with no actions");
                run.widest = run.widest.max(actions.len());
                let i = below(&mut policy, actions.len() as u32) as usize;
                game.apply(actions[i])
                    .expect("an enumerated action is legal");
                run.script.push(i);
                run.decisions += 1;
            }
        }
    }
    run.score = game.score().total;
    assert_eq!(game.round().get(), 6, "a finished game is in round 6");
    run
}

/// Replay a recorded script against the same seed. Only the chance nodes draw
/// from the generator, so the dice fall exactly as they did.
fn replay(seed: u64, script: &[usize]) -> i32 {
    let mut dice = Rng::seed_from_u64(seed);
    let mut game = PrettyClever::new(&mut dice);
    let mut step = 0;
    loop {
        match game.node() {
            Node::Over => break,
            Node::Chance => game.roll(&mut dice),
            Node::Decision(actions) => {
                let i = script[step];
                game.apply(actions[i]).expect("the script is legal");
                step += 1;
            }
        }
    }
    assert_eq!(step, script.len(), "the script was not consumed exactly");
    game.score().total
}

/// The widest action list and the deepest queue a policy that is *trying* to
/// stretch them can reach: at every decision it plays the action that leaves
/// the pending queue deepest, breaking ties towards the wider node.
///
/// A second witness with a different bias, not a proof. A uniform-random walk
/// could plausibly under-sample the cascades that stack decisions up; this one
/// searches for them and finds nothing the random walk missed.
fn probe(seed: u64) -> (usize, usize) {
    let mut dice = Rng::seed_from_u64(seed);
    let mut game = PrettyClever::new(&mut dice);
    let (mut widest, mut deepest) = (0, game.pending().count());

    loop {
        deepest = deepest.max(game.pending().count());
        match game.node() {
            Node::Over => break,
            Node::Chance => game.roll(&mut dice),
            Node::Decision(actions) => {
                widest = widest.max(actions.len());
                let best = actions
                    .iter()
                    .max_by_key(|&&a| {
                        let mut branch = game.clone();
                        let _ = branch.apply(a);
                        let after = match branch.node() {
                            Node::Decision(next) => next.len(),
                            _ => 0,
                        };
                        (branch.pending().count(), after)
                    })
                    .copied()
                    .expect("a non-empty action list");
                game.apply(best).expect("an enumerated action is legal");
            }
        }
    }
    (widest, deepest)
}

/// The end-to-end milestone, and the two measurements §15.1 and §13 ask for.
///
/// The TypeScript prototype's `random` bot averages 58.7 ± 17.0 on this game.
/// The band is loose on purpose — action-list composition can differ slightly
/// between the two engines — but a large gap means a rules bug, so the number
/// is printed either way.
#[test]
fn a_uniform_random_policy_plays_complete_games() {
    let mut total: i64 = 0;
    let mut sum_sq: i64 = 0;
    let (mut lo, mut hi) = (i32::MAX, i32::MIN);
    let mut widest = 0;
    let mut deepest = 0;
    let mut decisions = 0;

    for seed in 1..=GAMES {
        let run = play(seed);
        total += i64::from(run.score);
        sum_sq += i64::from(run.score) * i64::from(run.score);
        lo = lo.min(run.score);
        hi = hi.max(run.score);
        widest = widest.max(run.widest);
        deepest = deepest.max(run.deepest);
        decisions = decisions.max(run.decisions);
    }

    let n = GAMES as f64;
    let mean = total as f64 / n;
    let sd = (sum_sq as f64 / n - mean * mean).sqrt();
    println!("random policy over {GAMES} games: mean {mean:.1} ± {sd:.1}, range {lo}..={hi}");
    println!("widest action list: {widest} (MAX_ACTIONS = {MAX_ACTIONS})");
    println!("deepest pending queue: {deepest} (PENDING = {PENDING})");
    println!("most decisions in one game: {decisions} (limit {DECISION_LIMIT})");

    assert!(
        (45.0..=75.0).contains(&mean),
        "random mean {mean:.1} is far from the prototype's 58.7"
    );
    assert!(lo >= 0, "a score went negative: {lo}");
    assert!(hi < 400, "a random game scored {hi}");
    assert!(
        widest < MAX_ACTIONS,
        "MAX_ACTIONS = {MAX_ACTIONS} is not above the observed {widest}"
    );
    assert!(
        deepest < PENDING,
        "PENDING = {PENDING} is not above the observed {deepest}"
    );
}

/// The same two measurements, against a policy that is *trying* to overflow
/// them.
#[test]
fn a_queue_seeking_policy_does_not_overflow_either_constant() {
    let (mut widest, mut deepest) = (0, 0);
    for seed in 1..=2_000 {
        let (w, d) = probe(seed);
        widest = widest.max(w);
        deepest = deepest.max(d);
    }
    println!("queue-seeking policy: widest action list {widest}, deepest pending {deepest}");
    assert!(widest < MAX_ACTIONS, "MAX_ACTIONS is not above {widest}");
    assert!(deepest < PENDING, "PENDING is not above {deepest}");
}

#[test]
fn replaying_a_seed_and_its_action_indices_reproduces_the_score() {
    for seed in 1..=200 {
        let run = play(seed);
        assert_eq!(replay(seed, &run.script), run.score, "seed {seed}");
        // And the run itself is a function of the seed alone.
        assert_eq!(play(seed).script, run.script, "seed {seed}");
    }
}

#[test]
fn a_finished_game_refuses_every_action() {
    let mut rng = Rng::seed_from_u64(99);
    let mut game = PrettyClever::new(&mut rng);
    loop {
        match game.node() {
            Node::Over => break,
            Node::Chance => game.roll(&mut rng),
            Node::Decision(actions) => {
                let i = below(&mut rng, actions.len() as u32) as usize;
                game.apply(actions[i]).unwrap();
            }
        }
    }
    assert!(game.node().is_over());
    for action in [
        Action::Skip,
        Action::EndTurn,
        Action::Reroll,
        Action::PassiveSkip,
    ] {
        assert!(game.apply(action).is_err(), "{action:?} after the end");
    }
}

proptest! {
    /// Every enumerated action applies cleanly, from any state a random walk
    /// can reach, whichever action is taken.
    #[test]
    fn every_enumerated_action_applies(seed in any::<u64>(), depth in 0usize..120) {
        let mut rng = Rng::seed_from_u64(seed);
        let mut game = PrettyClever::new(&mut rng);

        // Walk to an arbitrary state.
        for _ in 0..depth {
            match game.node() {
                Node::Over => break,
                Node::Chance => game.roll(&mut rng),
                Node::Decision(actions) => {
                    let i = below(&mut rng, actions.len() as u32) as usize;
                    prop_assert!(game.apply(actions[i]).is_ok());
                }
            }
        }

        // From there, *every* offered action is legal on a fresh clone.
        if let Node::Decision(actions) = game.node() {
            prop_assert!(!actions.is_empty());
            prop_assert!(actions.len() <= MAX_ACTIONS);
            for &action in actions.iter() {
                let mut branch = game.clone();
                prop_assert!(branch.apply(action).is_ok(), "{action:?}");
                // And describing it never panics.
                prop_assert!(!game.describe(action).to_string().is_empty());
            }
            // No action is offered twice.
            for (i, a) in actions.iter().enumerate() {
                prop_assert!(!actions[i + 1..].contains(a), "duplicate {a:?}");
            }
        }
    }

    /// A game terminates within a bounded number of decisions whatever the
    /// policy, and its score never leaves the reachable range.
    #[test]
    fn every_game_terminates(seed in any::<u64>()) {
        let run = play(seed);
        prop_assert!(run.decisions < DECISION_LIMIT);
        prop_assert!(run.score >= 0);
        prop_assert!(run.deepest < PENDING);
        prop_assert!(run.widest < MAX_ACTIONS);
    }

    /// The score only ever grows: no action of this game takes points away.
    #[test]
    fn the_score_never_goes_backwards(seed in any::<u64>()) {
        let mut rng = Rng::seed_from_u64(seed);
        let mut game = PrettyClever::new(&mut rng);
        let mut last = game.score().total;
        loop {
            match game.node() {
                Node::Over => break,
                Node::Chance => game.roll(&mut rng),
                Node::Decision(actions) => {
                    let i = below(&mut rng, actions.len() as u32) as usize;
                    game.apply(actions[i]).unwrap();
                }
            }
            let now = game.score().total;
            prop_assert!(now >= last, "{last} → {now}");
            last = now;
        }
    }
}
