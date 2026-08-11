//! The scalar vocabulary both games speak: die faces, two-die sums, die
//! identities, where a die sits, and which round it is.

use core::fmt;
use core::num::NonZeroU8;

use rand_core::RngCore;

use crate::rng::below;

/// Points. Signed, because *Twice as Clever*'s green area scores subtraction
/// pairs and a whole area — and therefore the fox multiplier — can go negative.
pub type Score = i32;

/// A die face, 1..=6.
///
/// Represented as a [`NonZeroU8`] so that `Option<Face>` is one byte: an empty
/// slot of a write track is `None` rather than the `0` sentinel the TypeScript
/// prototype open-codes everywhere.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Face(NonZeroU8);

/// `Face::new(v).unwrap()` in const position.
const fn face(v: u8) -> Face {
    match Face::new(v) {
        Some(f) => f,
        None => panic!("not a die face"),
    }
}

impl Face {
    /// The lowest face.
    pub const ONE: Face = face(1);
    /// Face 2.
    pub const TWO: Face = face(2);
    /// Face 3.
    pub const THREE: Face = face(3);
    /// Face 4.
    pub const FOUR: Face = face(4);
    /// Face 5.
    pub const FIVE: Face = face(5);
    /// The highest face. Also the face that lifts *That's Pretty Clever*'s
    /// purple ascending constraint.
    pub const SIX: Face = face(6);

    /// Every face in ascending order — the enumeration a "choose any value"
    /// bonus (*Twice*'s colored `?`) iterates.
    pub const ALL: [Face; 6] = [
        Face::ONE,
        Face::TWO,
        Face::THREE,
        Face::FOUR,
        Face::FIVE,
        Face::SIX,
    ];

    /// A face from its printed value, or `None` outside 1..=6. The only
    /// constructor, so a `Face` is always a value a d6 can show.
    #[must_use]
    pub const fn new(v: u8) -> Option<Face> {
        match v {
            1..=6 => match NonZeroU8::new(v) {
                Some(n) => Some(Face(n)),
                None => None,
            },
            _ => None,
        }
    }

    /// The printed value, 1..=6.
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0.get()
    }

    /// The printed value as a score contribution — write tracks sum faces.
    #[must_use]
    pub const fn score(self) -> Score {
        self.0.get() as Score
    }

    /// Roll one d6, uniformly.
    pub fn roll(rng: &mut impl RngCore) -> Face {
        // 1 + U(0..6); `below` is rejection-sampled, so no modulo bias.
        match Face::new(1 + below(rng, 6) as u8) {
            Some(f) => f,
            // Unreachable: `below(_, 6)` is in 0..6.
            None => Face::ONE,
        }
    }
}

impl fmt::Debug for Face {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Face({})", self.get())
    }
}

impl fmt::Display for Face {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.get())
    }
}

/// The sum of two faces, 2..=12 — the value marked in the blue area of both
/// games, which is always blue + white whichever of the two dice is spent.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pips(u8);

impl Pips {
    /// The smallest sum of two dice.
    pub const MIN: Pips = Pips(2);
    /// The largest sum of two dice.
    pub const MAX: Pips = Pips(12);

    /// A sum from its value, or `None` outside 2..=12.
    #[must_use]
    pub const fn new(v: u8) -> Option<Pips> {
        match v {
            2..=12 => Some(Pips(v)),
            _ => None,
        }
    }

    /// The sum of two faces. Always in range, so infallible.
    #[must_use]
    pub const fn of(a: Face, b: Face) -> Pips {
        Pips(a.get() + b.get())
    }

    /// The value, 2..=12.
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }

    /// Every sum in ascending order — the enumeration *Twice*'s blue `?`
    /// iterates.
    pub fn all() -> impl Iterator<Item = Pips> + Clone {
        (2..=12).map(Pips)
    }
}

impl fmt::Debug for Pips {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Pips({})", self.0)
    }
}

impl fmt::Display for Pips {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The identity of a die within the mat: an index into the game's own die
/// order. The core never learns that die 4 is orange in one game and pink in
/// the other.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Die(u8);

impl Die {
    /// The largest number of dice a [`DieSet`](crate::DieSet) can hold, and
    /// therefore the largest mat the core supports.
    pub const MAX: usize = 8;

    /// A die by index. Indices at or above [`Die::MAX`] cannot be held by a
    /// [`DieSet`](crate::DieSet); debug builds assert, release builds wrap the
    /// value into range so no public entry point panics.
    #[must_use]
    pub const fn new(i: u8) -> Die {
        debug_assert!((i as usize) < Die::MAX, "die index out of range");
        Die(i % Die::MAX as u8)
    }

    /// The index, for the caller's own per-die arrays.
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }

    /// The index as a `usize`, for slicing.
    #[must_use]
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

impl fmt::Debug for Die {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Die({})", self.0)
    }
}

impl fmt::Display for Die {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "d{}", self.0)
    }
}

/// Where a die sits during a turn.
///
/// A die leaves the pool either by being picked (to the field) or by showing
/// less than a picked die (to the platter); both are out of play until the
/// turn ends — or, in *Twice as Clever*, until a return recalls one.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub enum Loc {
    /// Available: rolled by the next roll, pickable.
    #[default]
    Pool,
    /// Pushed onto the silver platter by a higher pick, or set aside by the
    /// passive roll. Only the passive pick and a return can touch it.
    Platter,
    /// Placed on a dice field by a pick. Never moves again this turn.
    Field,
}

/// The round number, 1-based, saturating at the game's round count.
///
/// Both games play six rounds; the count is the game's to know, so every
/// method that could pass the end takes it as an argument.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Round(u8);

impl Round {
    /// The round a game starts in.
    pub const FIRST: Round = Round(1);

    /// A round by number, or `None` for 0 — there is no round zero.
    #[must_use]
    pub const fn new(n: u8) -> Option<Round> {
        match n {
            0 => None,
            _ => Some(Round(n)),
        }
    }

    /// The round number, 1-based.
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }

    /// The round number, 0-based — the index into a round-bonus table.
    #[must_use]
    pub const fn index(self) -> usize {
        self.0 as usize - 1
    }

    /// Whether this is the game's final round, after whose passive turn the
    /// game is over.
    #[must_use]
    pub const fn is_last(self, last: Round) -> bool {
        self.0 >= last.0
    }

    /// Advance to the next round, saturating at `last`. Returns `false` when
    /// there was no next round — the game is over.
    pub fn advance(&mut self, last: Round) -> bool {
        if self.is_last(last) {
            false
        } else {
            self.0 += 1;
            true
        }
    }
}

impl Default for Round {
    fn default() -> Self {
        Round::FIRST
    }
}

impl fmt::Debug for Round {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Round({})", self.0)
    }
}

impl fmt::Display for Round {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;
    use rand_core::SeedableRng;

    #[test]
    fn face_rejects_out_of_range() {
        assert!(Face::new(0).is_none());
        assert!(Face::new(7).is_none());
        for v in 1..=6u8 {
            assert_eq!(Face::new(v).unwrap().get(), v);
        }
    }

    #[test]
    fn option_face_is_one_byte() {
        assert_eq!(core::mem::size_of::<Option<Face>>(), 1);
        assert_eq!(core::mem::size_of::<Face>(), 1);
    }

    #[test]
    fn faces_order_by_value() {
        assert!(Face::ONE < Face::SIX);
        assert_eq!(Face::ALL.iter().max(), Some(&Face::SIX));
        for (i, f) in Face::ALL.iter().enumerate() {
            assert_eq!(f.get() as usize, i + 1);
        }
    }

    #[test]
    fn roll_covers_all_faces_and_nothing_else() {
        let mut rng = Rng::seed_from_u64(7);
        let mut seen = [0u32; 7];
        for _ in 0..60_000 {
            let f = Face::roll(&mut rng);
            seen[f.get() as usize] += 1;
        }
        assert_eq!(seen[0], 0);
        for count in &seen[1..] {
            // 10_000 expected; a wide band that only a broken roll fails.
            assert!(*count > 9_000 && *count < 11_000, "skewed: {seen:?}");
        }
    }

    #[test]
    fn pips_sum_two_faces() {
        assert_eq!(Pips::of(Face::ONE, Face::ONE), Pips::MIN);
        assert_eq!(Pips::of(Face::SIX, Face::SIX), Pips::MAX);
        assert_eq!(Pips::of(Face::TWO, Face::THREE).get(), 5);
        assert!(Pips::new(1).is_none());
        assert!(Pips::new(13).is_none());
        assert_eq!(Pips::all().count(), 11);
    }

    #[test]
    fn die_indexes_itself() {
        assert_eq!(Die::new(3).index(), 3);
        assert_eq!(Die::new(3).get(), 3);
    }

    #[test]
    fn round_advances_and_saturates() {
        let last = Round::new(6).unwrap();
        let mut r = Round::FIRST;
        assert_eq!(r.index(), 0);
        for expected in 2..=6 {
            assert!(r.advance(last));
            assert_eq!(r.get(), expected);
        }
        assert!(r.is_last(last));
        assert!(!r.advance(last));
        assert_eq!(r.get(), 6);
        assert!(Round::new(0).is_none());
    }
}
