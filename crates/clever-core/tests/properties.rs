//! Property tests for the invariants the games rest on.
//!
//! The unit tests next to each primitive pin down worked examples; these pin
//! down the rules those examples are instances of.

use clever_core::{Bar, Die, DieSet, Face, Loc, Mat, Pending, Rng, RngCore, SeedableRng, Unlock};
use proptest::prelude::*;

const N: usize = 6;

/// Six faces, 1..=6.
fn faces() -> impl Strategy<Value = [u8; N]> {
    prop::array::uniform(1u8..=6)
}

/// Six locations.
fn locs() -> impl Strategy<Value = [u8; N]> {
    prop::array::uniform(0u8..3)
}

fn loc_of(n: u8) -> Loc {
    match n {
        0 => Loc::Pool,
        1 => Loc::Platter,
        _ => Loc::Field,
    }
}

fn build(faces: [u8; N], locs: [u8; N]) -> Mat<N> {
    let mut m = Mat::<N>::new(&mut Rng::seed_from_u64(0));
    for i in 0..N {
        let d = Die::new(i as u8);
        m.set_face(d, Face::new(faces[i]).unwrap());
        m.set_loc(d, loc_of(locs[i]));
    }
    m
}

proptest! {
    /// `take` moves exactly the pool dice showing *strictly* less than the
    /// pick, and nothing else moves.
    #[test]
    fn take_moves_exactly_the_strictly_lower_pool_dice(
        faces in faces(),
        locs in locs(),
        picked in 0u8..N as u8,
    ) {
        let before = build(faces, locs);
        let mut after = before;
        let d = Die::new(picked);

        let moved = after.take(d);

        let expected: DieSet = before
            .dice()
            .filter(|&o| o != d
                && before.loc(o) == Loc::Pool
                && before.face(o) < before.face(d))
            .collect();
        prop_assert_eq!(moved, expected);

        // The pick is on a field; every moved die is on the platter; nothing
        // else changed location, and no face changed at all.
        prop_assert_eq!(after.loc(d), Loc::Field);
        for o in before.dice() {
            prop_assert_eq!(after.face(o), before.face(o));
            let want = if o == d {
                Loc::Field
            } else if moved.contains(o) {
                Loc::Platter
            } else {
                before.loc(o)
            };
            prop_assert_eq!(after.loc(o), want, "{} moved unexpectedly", o);
        }
    }

    /// A die is never in its own moved set, and equal faces never move.
    #[test]
    fn take_excludes_itself_and_its_equals(
        faces in faces(),
        picked in 0u8..N as u8,
    ) {
        let mut m = build(faces, [0; N]);
        let d = Die::new(picked);
        let face = m.face(d);
        let moved = m.take(d);
        prop_assert!(!moved.contains(d));
        for o in moved {
            prop_assert!(m.face(o) < face);
        }
    }

    /// The passive roll re-rolls every die — in index order, off the same RNG
    /// stream — and sets aside exactly the three lowest.
    #[test]
    fn passive_roll_rerolls_everything_and_keeps_three(
        faces in faces(),
        locs in locs(),
        seed in any::<u64>(),
    ) {
        let mut m = build(faces, locs);

        let mut rng = Rng::seed_from_u64(seed);
        let mut oracle = Rng::seed_from_u64(seed);
        let platter = m.passive_roll(&mut rng);

        // Every die was rolled, in index order.
        for d in m.dice() {
            prop_assert_eq!(m.face(d), Face::roll(&mut oracle));
        }

        prop_assert_eq!(platter.len(), Mat::<N>::PASSIVE_PLATTER);
        prop_assert_eq!(m.platter().count(), Mat::<N>::PASSIVE_PLATTER);
        prop_assert_eq!(m.field().count(), 0);
        prop_assert_eq!(m.pool().count(), N - Mat::<N>::PASSIVE_PLATTER);
        prop_assert!(platter.iter().all(|d| m.loc(d) == Loc::Platter));

        // "Three lowest": nothing left in the pool is below the platter.
        let hi = m.platter().map(|d| m.face(d)).max().unwrap();
        let lo = m.pool().map(|d| m.face(d)).min().unwrap();
        prop_assert!(hi <= lo);
    }

    /// `recall` moves platter dice back to the pool and refuses anything else.
    #[test]
    fn recall_only_accepts_platter_dice(
        faces in faces(),
        locs in locs(),
        die in 0u8..N as u8,
    ) {
        let before = build(faces, locs);
        let mut after = before;
        let d = Die::new(die);
        let moved = after.recall(d);
        prop_assert_eq!(moved, before.loc(d) == Loc::Platter);
        prop_assert_eq!(after.loc(d), if moved { Loc::Pool } else { before.loc(d) });
        for o in before.dice().filter(|&o| o != d) {
            prop_assert_eq!(after.loc(o), before.loc(o));
        }
    }

    /// Inserting, iterating and removing round-trips through a `DieSet`.
    #[test]
    fn dieset_round_trips(indices in prop::collection::vec(0u8..Die::MAX as u8, 0..20)) {
        let mut set = DieSet::EMPTY;
        for &i in &indices {
            set.insert(Die::new(i));
        }

        let mut want: Vec<u8> = indices.clone();
        want.sort_unstable();
        want.dedup();

        let got: Vec<u8> = set.iter().map(Die::get).collect();
        prop_assert_eq!(&got, &want);
        prop_assert_eq!(set.len(), want.len());
        prop_assert_eq!(set.is_empty(), want.is_empty());
        prop_assert_eq!(set, indices.iter().map(|&i| Die::new(i)).collect::<DieSet>());

        for i in 0..Die::MAX as u8 {
            prop_assert_eq!(set.contains(Die::new(i)), want.contains(&i));
        }

        // Removing everything that went in empties the set again.
        for &i in &indices {
            set.remove(Die::new(i));
        }
        prop_assert!(set.is_empty());
    }

    /// A bar never hands out more than it has circled, never circles past its
    /// cap, and reports `Filled` exactly once — on the unlock that fills it.
    #[test]
    fn bar_never_over_reports(
        cap in 1u8..10,
        ops in prop::collection::vec(any::<bool>(), 0..64),
    ) {
        let mut bar = Bar::new(cap);
        let mut filled = 0;
        let mut spent = 0u8;
        let mut gained = 0u8;

        for unlock in ops {
            if unlock {
                match bar.unlock() {
                    Unlock::Gained => gained += 1,
                    Unlock::Filled => {
                        gained += 1;
                        filled += 1;
                    }
                    Unlock::Overflow => prop_assert!(bar.is_full()),
                }
            } else if bar.spend() {
                spent += 1;
            } else {
                prop_assert_eq!(bar.available(), 0);
            }

            prop_assert_eq!(bar.circled(), gained);
            prop_assert_eq!(bar.spent(), spent);
            prop_assert_eq!(bar.available(), gained - spent);
            prop_assert!(bar.available() <= bar.circled());
            prop_assert!(bar.circled() <= cap);
            prop_assert_eq!(bar.is_full(), bar.circled() == cap);
        }
        prop_assert!(filled <= 1);
        prop_assert_eq!(filled == 1, bar.is_full());
    }

    /// The queue is FIFO, `push_front` is LIFO onto its head, and
    /// `retain_resolvable` removes exactly the leading run it reports.
    #[test]
    fn pending_queues_and_prunes(
        pushes in prop::collection::vec((any::<bool>(), 0u8..8), 0..8),
        keep in 0u8..8,
    ) {
        let mut q = Pending::<u8, 8>::new();
        let mut model: Vec<u8> = Vec::new();

        for (front, value) in pushes {
            let pushed = if front { q.push_front(value) } else { q.push_back(value) };
            prop_assert!(pushed.is_ok());
            if front { model.insert(0, value) } else { model.push(value) }
        }
        prop_assert_eq!(q.iter().collect::<Vec<_>>(), model.clone());
        prop_assert_eq!(q.head(), model.first().copied());
        prop_assert_eq!(q.len(), model.len());

        // Entries below `keep` are unresolvable and are dropped from the head.
        let lost = q.retain_resolvable(|c| c >= keep);
        let dropped = model.iter().take_while(|&&c| c < keep).count();
        prop_assert_eq!(lost as usize, dropped);
        prop_assert_eq!(q.iter().collect::<Vec<_>>(), model[dropped..].to_vec());

        // Draining reproduces the rest, in order.
        for want in model[dropped..].iter().copied() {
            prop_assert_eq!(q.pop(), Some(want));
        }
        prop_assert!(q.is_empty());
        prop_assert_eq!(q.pop(), None);
    }

    /// A seeded run is reproducible: the same seed drives the mat down the
    /// same path, and a different draw order is a different game.
    #[test]
    fn seeded_runs_replay(seed in any::<u64>(), picks in prop::collection::vec(0u8..6, 1..12)) {
        let run = |seed: u64| {
            let mut rng = Rng::seed_from_u64(seed);
            let mut mat = Mat::<N>::new(&mut rng);
            let mut trace = Vec::new();
            for &p in &picks {
                let pool: Vec<Die> = mat.pool().collect();
                if pool.is_empty() {
                    trace.push(mat.passive_roll(&mut rng));
                    mat.reset();
                    mat.roll_pool(&mut rng);
                } else {
                    trace.push(mat.take(pool[p as usize % pool.len()]));
                    mat.roll_pool(&mut rng);
                }
            }
            (mat, trace)
        };
        prop_assert_eq!(run(seed), run(seed));
    }
}

/// `Option<Face>` is one byte: the niche optimization the whole track
/// representation rests on.
#[test]
fn option_face_is_one_byte() {
    assert_eq!(std::mem::size_of::<Face>(), 1);
    assert_eq!(std::mem::size_of::<Option<Face>>(), 1);
    assert_eq!(std::mem::size_of::<DieSet>(), 1);
    assert_eq!(std::mem::size_of::<Mat<6>>(), 12);
}

/// The rejection sampler terminates and covers its range for every bound a
/// game could pass it.
#[test]
fn below_is_uniform_enough() {
    let mut rng = Rng::seed_from_u64(0xBEEF);
    for n in 1u32..=12 {
        let mut counts = vec![0u32; n as usize];
        for _ in 0..(2_000 * n) {
            counts[clever_core::below(&mut rng, n) as usize] += 1;
        }
        let (lo, hi) = (*counts.iter().min().unwrap(), *counts.iter().max().unwrap());
        assert!(hi - lo < 500, "n={n} skewed: {counts:?}");
    }
    // And it still terminates on the degenerate bound.
    assert_eq!(clever_core::below(&mut rng, 0), 0);
    let _ = rng.next_u32();
}
