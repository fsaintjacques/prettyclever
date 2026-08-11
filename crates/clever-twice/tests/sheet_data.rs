//! The transcription tests: every printed number and every printed bonus,
//! checked against `src/engine/variants/twice-as-clever.ts` — the
//! authoritative sheet data — rather than against a second hand-typed copy.
//!
//! Sheet data is transcribed from a physical score sheet, and a typo in it is
//! the one failure mode nothing else catches: the game still plays, the tests
//! still pass, and the numbers are quietly wrong. So these tests parse the
//! TypeScript and compare cell for cell.
//!
//! They read the Rust side through the *public* API only, which makes them a
//! check on behaviour as well as on data: a group bonus is verified by marking
//! the group and watching what fires, and pink's gates by writing one below
//! the threshold and one at it.

use clever_core::{Face, Pips, Rng, Score, SeedableRng, Solitaire};
use clever_twice::{
    Area, Blue, Color, Effect, FreeTarget, Green, LatticeCell, LatticeState, Pink, Placement,
    Silver, SilverCell, SilverRow, TwiceAsClever, Yellow,
};

/// A fresh game, for the checks that read the sheet through the phase machine.
fn game() -> TwiceAsClever {
    TwiceAsClever::new(&mut Rng::seed_from_u64(0xC1EE_7175))
}

// ---------------------------------------------------------------------------
// A very small reader for the subset of TypeScript the sheet data is written in
// ---------------------------------------------------------------------------

/// The authoritative sheet, as text.
fn source() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/engine/variants/twice-as-clever.ts"
    );
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("the authoritative sheet data at {path} must be readable: {e}"))
}

/// The bracketed run that follows `marker`, brackets included.
fn bracketed<'a>(text: &'a str, marker: &str, open: u8) -> &'a str {
    let close = match open {
        b'[' => b']',
        b'{' => b'}',
        b'(' => b')',
        _ => unreachable!("only lists, objects and calls are read"),
    };
    let from = text
        .find(marker)
        .unwrap_or_else(|| panic!("{marker} is missing from the sheet data"));
    let rest = &text[from..];
    let start = rest
        .bytes()
        .position(|b| b == open)
        .unwrap_or_else(|| panic!("{marker} is not followed by a {}", open as char));
    let mut depth = 0usize;
    for (i, b) in rest.as_bytes()[start..].iter().enumerate() {
        if *b == open {
            depth += 1;
        } else if *b == close {
            depth -= 1;
            if depth == 0 {
                return &rest[start..start + i + 1];
            }
        }
    }
    panic!("{marker} is not closed");
}

/// One `const <name> = …({ … })` definition.
fn area<'a>(src: &'a str, name: &str) -> &'a str {
    bracketed(src, &format!("const {name} = "), b'{')
}

/// The value of `key:` inside `object`, as a bracketed run.
fn field<'a>(object: &'a str, key: &str, open: u8) -> &'a str {
    bracketed(object, &format!("{key}:"), open)
}

/// Split a bracketed run into its top-level entries.
fn entries(list: &str) -> Vec<&str> {
    let inner = &list[1..list.len() - 1];
    let (mut depth, mut start, mut out) = (0usize, 0usize, Vec::new());
    let mut quote: Option<u8> = None;
    for (i, b) in inner.as_bytes().iter().enumerate() {
        match quote {
            Some(q) => {
                if *b == q {
                    quote = None;
                }
            }
            None => match *b {
                b'\'' | b'"' => quote = Some(*b),
                b'[' | b'{' | b'(' => depth += 1,
                b']' | b'}' | b')' => depth -= 1,
                b',' if depth == 0 => {
                    out.push(inner[start..i].trim());
                    start = i + 1;
                }
                _ => {}
            },
        }
    }
    let last = inner[start..].trim();
    if !last.is_empty() {
        out.push(last);
    }
    out
}

/// A list of numbers, with `null` as `None`.
fn numbers(list: &str) -> Vec<Option<i64>> {
    entries(list)
        .into_iter()
        .map(|e| match e {
            "null" => None,
            n => Some(n.parse().unwrap_or_else(|_| panic!("not a number: {n}"))),
        })
        .collect()
}

/// A list of numbers with no holes.
fn plain(list: &str) -> Vec<i64> {
    numbers(list)
        .into_iter()
        .map(|n| n.expect("no holes in this list"))
        .collect()
}

/// The value of `key:` up to the end of its entry, unbracketed.
fn scalar<'a>(object: &'a str, key: &str) -> Option<&'a str> {
    let from = object.find(&format!("{key}:"))? + key.len() + 1;
    let rest = &object[from..];
    let (mut depth, mut quote) = (0usize, None::<u8>);
    for (i, b) in rest.as_bytes().iter().enumerate() {
        match quote {
            Some(q) => {
                if *b == q {
                    quote = None;
                }
            }
            None => match *b {
                b'\'' | b'"' => quote = Some(*b),
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' if depth > 0 => depth -= 1,
                b',' | b'}' if depth == 0 => return Some(rest[..i].trim()),
                _ => {}
            },
        }
    }
    Some(rest.trim())
}

/// The arguments of a call like `free('yellow')`.
fn args(call: &str) -> Vec<String> {
    let inside = bracketed(call, "(", b'(');
    entries(&format!("[{}]", &inside[1..inside.len() - 1]))
        .into_iter()
        .map(|a| a.trim_matches(['\'', '"']).to_string())
        .collect()
}

/// The area a `free('…')` names.
fn target(name: &str) -> FreeTarget {
    FreeTarget::ALL
        .into_iter()
        .find(|t| t.name() == name)
        .unwrap_or_else(|| panic!("no colored ? targets {name}"))
}

/// The [`Effect`] a TypeScript bonus expression names.
///
/// The variant file binds `fox`, `reroll`, `plus1` and `ret` to constants and
/// writes the colored `?`s as `free('area')` calls, so those five shapes are
/// the whole vocabulary.
fn effect(text: &str) -> Effect {
    let text = text.trim();
    match text {
        "fox" => return Effect::Fox,
        "reroll" => return Effect::Reroll,
        "plus1" => return Effect::Plus1,
        "ret" => return Effect::Return,
        _ => {}
    }
    if text.starts_with("free(") {
        return Effect::Free(target(&args(text)[0]));
    }
    panic!("unknown bonus expression: {text}");
}

/// The `{ index: bonus }` map of a track, as a slot-indexed list.
fn cell_bonuses(object: &str, slots: usize) -> Vec<Option<Effect>> {
    let mut out = vec![None; slots];
    for entry in entries(field(object, "cellBonuses", b'{')) {
        let (index, bonus) = entry.split_once(':').expect("index: bonus");
        let index: usize = index.trim().parse().expect("a cell index");
        assert!(index < slots, "cell {index} is off the track");
        out[index] = Some(effect(bonus));
    }
    out
}

/// The `{ index: minimum }` map of pink's bonus gates.
fn gates(object: &str, slots: usize) -> Vec<Option<u8>> {
    let mut out = vec![None; slots];
    for entry in entries(field(object, "bonusMinValues", b'{')) {
        let (index, min) = entry.split_once(':').expect("index: minimum");
        let index: usize = index.trim().parse().expect("a cell index");
        out[index] = Some(min.trim().parse().expect("a printed minimum"));
    }
    out
}

/// One row or column of a grid area.
struct Group {
    cells: Vec<usize>,
    bonus: Option<Effect>,
}

fn groups(object: &str) -> Vec<Group> {
    entries(field(object, "groups", b'['))
        .into_iter()
        .map(|g| Group {
            cells: plain(field(g, "cells", b'['))
                .into_iter()
                .map(|c| c as usize)
                .collect(),
            bonus: scalar(g, "bonus").map(effect),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Silver
// ---------------------------------------------------------------------------

#[test]
fn silver_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "silver");

    // Four rows, named after the dice whose chain marks land in them.
    let rows: Vec<&str> = entries(field(ts, "rows", b'['))
        .into_iter()
        .map(|r| r.trim_matches('\''))
        .collect();
    let ours: Vec<&str> = SilverRow::ALL.iter().map(|r| r.name()).collect();
    assert_eq!(rows, ours, "the row order is the sheet's own");
    assert_eq!(Silver::ROWS, rows.len());
    assert_eq!(Silver::CELLS, rows.len() * Silver::VALUES);

    // Every cell answers with the row and value the sheet lays it out at,
    // row-major.
    for (row, name) in rows.iter().enumerate() {
        for value in 1..=Silver::VALUES {
            let index = row * Silver::VALUES + value - 1;
            let cell = SilverCell::new(index as u8).expect("a silver cell");
            assert_eq!(cell.row().name(), *name, "cell {index}");
            assert_eq!(cell.value().get(), value as u8, "cell {index}");
            assert_eq!(SilverCell::at(cell.row(), cell.value()), cell);
        }
    }
    assert!(SilverCell::new(Silver::CELLS as u8).is_none());

    // Column bonuses: mark the value in every row and watch the last one fire.
    let column: Vec<Effect> = entries(field(ts, "columnBonuses", b'['))
        .into_iter()
        .map(effect)
        .collect();
    assert_eq!(column.len(), Silver::VALUES);
    for (i, want) in column.into_iter().enumerate() {
        let value = Face::new(i as u8 + 1).expect("a printed value");
        let mut grid = Silver::new();
        let (last, rest) = SilverRow::ALL.split_last().expect("four rows");
        for row in rest {
            assert_eq!(
                grid.apply(SilverCell::at(*row, value)),
                None,
                "column {value} fired early"
            );
        }
        assert_eq!(
            grid.apply(SilverCell::at(*last, value)),
            Some(want),
            "column {value}"
        );
    }

    // Each row scores on its own, by mark count.
    let points = plain(field(ts, "points", b'['));
    assert_eq!(points.len(), Silver::VALUES + 1);
    let mut grid = Silver::new();
    for (marks, want) in points.iter().enumerate() {
        assert_eq!(grid.score(), *want as Score, "{marks} marks in one row");
        if marks < Silver::VALUES {
            let value = Face::new(marks as u8 + 1).expect("a printed value");
            let _ = grid.apply(SilverCell::at(SilverRow::Yellow, value));
        }
    }
    // And the four rows are independent: a full grid is four full rows.
    assert_eq!(
        Silver::from_bits(u32::MAX).score(),
        4 * *points.last().expect("a full row") as Score
    );
}

// ---------------------------------------------------------------------------
// Yellow
// ---------------------------------------------------------------------------

#[test]
fn yellow_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "yellow");

    // The staggered layout, position for position: a hole is a position no
    // cell sits at, and every other one answers with its printed value.
    let values = numbers(field(ts, "values", b'['));
    assert_eq!(values.len(), 20, "a five-row, four-column lattice");
    for (position, value) in values.iter().enumerate() {
        let cell = LatticeCell::at(position as u8);
        match value {
            None => assert!(cell.is_none(), "position {position} is a hole"),
            Some(v) => {
                let cell = cell.expect("a real cell");
                assert_eq!(cell.value().get(), *v as u8, "position {position}");
                assert_eq!(cell.position(), position);
            }
        }
    }
    assert_eq!(
        Yellow::CELLS,
        values.iter().filter(|v| v.is_some()).count(),
        "the cells are exactly the non-null positions"
    );

    // Groups: circling every cell of a group fires its printed bonus, and not
    // one circle sooner. That catches a mask with a cell too many *and* one
    // with a cell too few.
    let ts_groups = groups(ts);
    assert_eq!(ts_groups.len(), 9, "five rows and four columns");
    for group in &ts_groups {
        let mut lattice = Yellow::new();
        let cells: Vec<LatticeCell> = group
            .cells
            .iter()
            .map(|&c| LatticeCell::at(c as u8).expect("a real cell"))
            .collect();
        let (last, rest) = cells.split_last().expect("a non-empty group");
        for cell in rest {
            assert!(
                lattice.apply(*cell).into_iter().next().is_none(),
                "{:?} fired early",
                group.cells
            );
        }
        let fired: Vec<Effect> = lattice.apply(*last).into_iter().collect();
        match group.bonus {
            Some(bonus) => assert!(fired.contains(&bonus), "{:?} → {fired:?}", group.cells),
            None => assert!(fired.is_empty(), "{:?} fired {fired:?}", group.cells),
        }
        // A group completes at *circled*; the crosses have not been made.
        assert_eq!(lattice.score(), 0, "circles score nothing");
    }
    // Every cell belongs to exactly one row group and one column group.
    for cell in 0..Yellow::CELLS {
        let position = LatticeCell::new(cell as u8).expect("a cell").position();
        assert_eq!(
            ts_groups
                .iter()
                .filter(|g| g.cells.contains(&position))
                .count(),
            2,
            "cell at {position}"
        );
    }

    // Only crosses score, on the printed table.
    let points = plain(field(ts, "points", b'['));
    assert_eq!(points.len(), Yellow::CELLS + 1);
    let mut lattice = Yellow::new();
    for cell in Yellow::cells() {
        let _ = lattice.apply(cell);
    }
    assert_eq!(lattice.score(), 0, "ten circles score nothing");
    for (crossed, want) in points.iter().enumerate() {
        assert_eq!(lattice.score(), *want as Score, "{crossed} crossed");
        if crossed < Yellow::CELLS {
            let cell = LatticeCell::new(crossed as u8).expect("a cell");
            let _ = lattice.apply(cell);
            assert_eq!(lattice.state(cell), LatticeState::Crossed);
        }
    }
}

// ---------------------------------------------------------------------------
// Blue
// ---------------------------------------------------------------------------

#[test]
fn blue_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "blue");

    let size: usize = scalar(ts, "size")
        .expect("a size")
        .parse()
        .expect("a number");
    assert_eq!(size, Blue::SLOTS);
    // The writable range is the two-die sum, which is what `Pips` *is*.
    assert_eq!(scalar(ts, "minValue"), Some("2"));
    assert_eq!(scalar(ts, "maxValue"), Some("12"));
    assert_eq!(Pips::MIN.get(), 2);
    assert_eq!(Pips::MAX.get(), 12);
    assert!(
        ts.contains("effectiveValue: (faces) => faces.blue + faces.white"),
        "blue's value is blue + white"
    );

    let points = plain(field(ts, "points", b'['));
    assert_eq!(points.len(), Blue::SLOTS + 1);
    let ours: Vec<Score> = points.iter().map(|&p| p as Score).collect();
    assert_eq!(Blue::points().to_vec(), ours);

    // Slot bonuses fire as the slot is written, and only then.
    let bonuses = cell_bonuses(ts, Blue::SLOTS);
    for (slot, want) in bonuses.iter().enumerate() {
        let mut track = Blue::from_sums(&vec![Pips::MAX; slot]);
        assert_eq!(track.next_slot(), slot);
        assert_eq!(track.apply(Pips::MAX), *want, "slot {slot}");
    }

    // The descent: the whole legality rule, checked against the sheet's own
    // range.
    let track = Blue::from_sums(&[Pips::new(7).expect("a sum")]);
    for v in 2..=12u8 {
        let sum = Pips::new(v).expect("a sum");
        assert_eq!(track.marks(sum).count(), usize::from(v <= 7), "{v} after 7");
    }
    assert_eq!(track.free_marks().count(), 6, "2..=7");
}

// ---------------------------------------------------------------------------
// Green
// ---------------------------------------------------------------------------

#[test]
fn green_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "green");

    let multipliers = plain(field(ts, "multipliers", b'['));
    assert_eq!(multipliers.len(), Green::SLOTS);
    assert_eq!(Green::SLOTS % 2, 0, "the slots pair up");
    for (slot, mult) in multipliers.iter().enumerate() {
        assert_eq!(Green::multipliers()[slot], *mult as Score, "slot {slot}");
        // And the multiplier is applied to the *face* at scoring time.
        let mut track = Green::from_faces(&vec![Face::ONE; slot]);
        assert_eq!(track.next_multiplier(), Some(*mult as Score));
        let _ = track.apply(Face::SIX);
        assert_eq!(track.written(slot), Some(6 * *mult as Score), "slot {slot}");
    }

    let bonuses = cell_bonuses(ts, Green::SLOTS);
    for (slot, want) in bonuses.iter().enumerate() {
        let mut track = Green::from_faces(&vec![Face::ONE; slot]);
        assert_eq!(track.apply(Face::SIX), *want, "slot {slot}");
    }

    // Consecutive slots pair, and a pair scores first − second.
    let track = Green::from_faces(&[Face::SIX; Green::SLOTS]);
    let want: Vec<Score> = (0..Green::PAIRS)
        .map(|p| 6 * (multipliers[2 * p] - multipliers[2 * p + 1]) as Score)
        .collect();
    assert_eq!(track.pairs().collect::<Vec<_>>(), want);
    assert_eq!(track.score(), want.iter().sum::<Score>());
}

// ---------------------------------------------------------------------------
// Pink
// ---------------------------------------------------------------------------

#[test]
fn pink_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "pink");

    // Every pink slot is ×1, which is why this crate's pink stores no
    // multipliers at all and simply sums the faces written.
    let multipliers = plain(field(ts, "multipliers", b'['));
    assert_eq!(multipliers.len(), Pink::SLOTS);
    assert!(
        multipliers.iter().all(|&m| m == 1),
        "pink prints no multipliers: {multipliers:?}"
    );

    let bonuses = cell_bonuses(ts, Pink::SLOTS);
    let gates = gates(ts, Pink::SLOTS);
    for (slot, want) in bonuses.iter().enumerate() {
        let gate = gates[slot];
        assert_eq!(
            Pink::gate(slot).map(Face::get),
            gate,
            "slot {slot}'s printed minimum"
        );
        assert_eq!(
            gate.is_some(),
            want.is_some(),
            "slot {slot}: a gate without a bonus, or the reverse"
        );

        let prefix = vec![Face::SIX; slot];
        // At the minimum — or unconditionally, for an ungated slot — the bonus
        // is granted.
        let mut track = Pink::from_faces(&prefix);
        let at = Face::new(gate.unwrap_or(1)).expect("a die face");
        assert_eq!(track.apply(at), *want, "slot {slot} at its minimum");

        // One below it, the slot still fills and the bonus is withheld.
        let Some(min) = gate else { continue };
        let below = Face::new(min - 1).expect("a die face below the gate");
        let mut track = Pink::from_faces(&prefix);
        let before = track.score();
        assert_eq!(track.apply(below), None, "slot {slot} below its minimum");
        assert_eq!(track.next_slot(), slot + 1, "the slot fills all the same");
        assert_eq!(track.score(), before + below.score());
    }
    // Pink's score is the plain sum of what was written.
    assert_eq!(
        Pink::from_faces(&[Face::SIX; Pink::SLOTS]).score(),
        6 * Pink::SLOTS as Score
    );
}

// ---------------------------------------------------------------------------
// The variant itself
// ---------------------------------------------------------------------------

#[test]
fn the_variant_matches_the_typescript_sheet() {
    let src = source();
    let ts = bracketed(&src, "export const twiceAsClever", b'{');

    let colors: Vec<&str> = entries(field(ts, "colors", b'['))
        .into_iter()
        .map(|c| c.trim_matches('\''))
        .collect();
    let names: Vec<&str> = Color::ALL.iter().map(|c| c.name()).collect();
    assert_eq!(colors, names, "the die order is the sheet's own");
    assert_eq!(scalar(ts, "wild"), Some("'white'"));
    assert!(Color::White.is_wild());

    assert_eq!(
        scalar(ts, "rounds").and_then(|r| r.parse::<u8>().ok()),
        Some(TwiceAsClever::ROUNDS.get())
    );
    assert_eq!(
        scalar(ts, "picksPerTurn").and_then(|p| p.parse::<u8>().ok()),
        Some(TwiceAsClever::PICKS_PER_TURN)
    );
    assert_eq!(
        scalar(ts, "plus1Scope"),
        Some("'round'"),
        "each die takes one +1 per round, not per turn"
    );

    // The five areas, in the order a breakdown lists them.
    let areas: Vec<&str> = entries(field(ts, "areas", b'['))
        .into_iter()
        .map(|a| a.trim())
        .collect();
    let breakdown = game().score();
    let ours: Vec<&str> = breakdown.areas.iter().map(|&(name, _)| name).collect();
    assert_eq!(areas, ours);

    // All three bars print six slots, and every one of them ends in a bonus.
    let bars = field(ts, "bars", b'{');
    let want = [
        ("reroll", Effect::Fox),
        ("plus1", Effect::Free(FreeTarget::Silver)),
        ("return", Effect::Free(FreeTarget::Pink)),
    ];
    for (bar, end) in want {
        let def = field(bars, bar, b'{');
        assert_eq!(
            scalar(def, "size").and_then(|s| s.parse::<u8>().ok()),
            Some(TwiceAsClever::BAR_SLOTS),
            "{bar} bar"
        );
        assert_eq!(
            scalar(def, "endBonus").map(effect),
            Some(end),
            "{bar} bar's end bonus"
        );
    }
    let fresh = game();
    for printed in [fresh.reroll_bar(), fresh.plus1_bar(), fresh.return_bar()] {
        assert_eq!(printed.cap(), TwiceAsClever::BAR_SLOTS);
    }

    // The round track: a re-roll, a +1, a return, the black ?, then nothing.
    let rounds = entries(field(ts, "roundBonuses", b'['));
    assert_eq!(rounds.len(), TwiceAsClever::ROUNDS.get() as usize);
    assert_eq!(effect(rounds[0]), Effect::Reroll);
    assert_eq!(effect(rounds[1]), Effect::Plus1);
    assert_eq!(effect(rounds[2]), Effect::Return);
    assert_eq!(rounds[4], "null");
    assert_eq!(rounds[5], "null");

    // The black ? is exactly the five colored ?s, in printed order.
    let options: Vec<Effect> = entries(field(rounds[3], "options", b'['))
        .into_iter()
        .map(effect)
        .collect();
    let ours: Vec<Effect> = FreeTarget::ALL.iter().map(|&t| Effect::Free(t)).collect();
    assert_eq!(options, ours);

    // The solo rating table.
    let table: Vec<(Score, String)> = entries(field(ts, "rating", b'['))
        .into_iter()
        .map(|row| {
            let min = match scalar(row, "min").expect("a minimum") {
                "-Infinity" => Score::MIN,
                n => n.parse().expect("a printed minimum"),
            };
            let label = scalar(row, "label").expect("a label");
            (min, label.trim_matches(['\'', '"']).to_string())
        })
        .collect();
    assert_eq!(table.len(), TwiceAsClever::RATING.len());
    for (i, (min, label)) in table.iter().enumerate() {
        assert_eq!(TwiceAsClever::RATING[i].min, *min, "rating row {i}");
        assert_eq!(TwiceAsClever::RATING[i].label, label, "rating row {i}");
    }
}

/// Only the silver die is *placed* in the silver grid — every other die
/// reaches it through the platter chain, and the sheet says so by listing one
/// color per area.
#[test]
fn each_area_admits_only_its_own_die() {
    let src = source();
    let game = game();
    for (name, color) in [
        ("silver", Color::Silver),
        ("yellow", Color::Yellow),
        ("blue", Color::Blue),
        ("green", Color::Green),
        ("pink", Color::Pink),
    ] {
        let ts = area(&src, name);
        let colors: Vec<&str> = entries(field(ts, "colors", b'['))
            .into_iter()
            .map(|c| c.trim_matches('\''))
            .collect();
        assert_eq!(colors, vec![name], "{name}");

        // Behaviourally, on a blank sheet where every area takes every face:
        // that die reaches the area and marks nothing else, and no other
        // colored die reaches it. White reaches everything; it is the wild.
        let own: Vec<Placement> = game.die_marks(color.die()).into_iter().collect();
        assert!(!own.is_empty(), "{color} can mark nothing at all");
        assert!(own.iter().all(|p| p.area() == name), "{color}: {own:?}");
        for other in Color::ALL {
            if other == color || other.is_wild() {
                continue;
            }
            assert!(
                game.die_marks(other.die()).iter().all(|p| p.area() != name),
                "{other} reaches {name}"
            );
        }
    }
    // And the wild die reaches all five.
    let wild: Vec<&str> = game
        .die_marks(Color::White.die())
        .into_iter()
        .map(Placement::area)
        .collect();
    for name in ["silver", "yellow", "blue", "green", "pink"] {
        assert!(wild.contains(&name), "white cannot reach {name}");
    }
}

/// The platter chain's rows are named after dice, and the correspondence is a
/// rule rather than a coincidence: the wild and silver dice are exactly the
/// ones with no row of their own, and they are exactly the ones that can place
/// into the grid in the first place.
#[test]
fn the_chain_rows_are_the_dice_that_are_not_placed_there() {
    let with_row: Vec<Color> = Color::ALL
        .into_iter()
        .filter(|c| c.silver_row().is_some())
        .collect();
    let row_names: Vec<&str> = with_row.iter().map(|c| c.name()).collect();
    let rows: Vec<&str> = SilverRow::ALL.iter().map(|r| r.name()).collect();
    assert_eq!(row_names, rows);

    let rowless: Vec<Color> = Color::ALL
        .into_iter()
        .filter(|c| c.silver_row().is_none())
        .collect();
    assert_eq!(rowless, vec![Color::White, Color::Silver]);
}
