//! The transcription tests: every printed number and every printed bonus,
//! checked against `src/engine/variants/thats-pretty-clever.ts` — the
//! authoritative sheet data — rather than against a second hand-typed copy.
//!
//! Sheet data is transcribed from a physical score sheet, and a typo in it is
//! the one failure mode nothing else catches: the game still plays, the tests
//! still pass, and the numbers are quietly wrong. (The design document's own
//! sketch of `Yellow::PRINTED` dropped cell 9 exactly this way.) So these
//! tests parse the TypeScript and compare cell for cell.
//!
//! They read the Rust side through the *public* API only, which makes them a
//! check on behaviour as well as on data: a row bonus is verified by crossing
//! the row and watching what fires.

use clever_core::{Face, Pips, Score};
use clever_pretty::{
    Area, Blue, BlueCell, Color, CrossTarget, Effect, Green, GreenCross, Orange, PrettyClever,
    Purple, WriteTarget, Yellow, YellowCell,
};

// ---------------------------------------------------------------------------
// A very small reader for the subset of TypeScript the sheet data is written in
// ---------------------------------------------------------------------------

/// The authoritative sheet, as text.
fn source() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/engine/variants/thats-pretty-clever.ts"
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

/// The arguments of a call like `writeNext('orange', 4)`.
fn args(call: &str) -> Vec<String> {
    let inside = bracketed(call, "(", b'(');
    entries(&format!("[{}]", &inside[1..inside.len() - 1]))
        .into_iter()
        .map(|a| a.trim_matches(['\'', '"']).to_string())
        .collect()
}

/// The `Effect` a TypeScript bonus expression names.
fn effect(text: &str) -> Effect {
    let text = text.trim();
    if text == "fox" {
        return Effect::Fox;
    }
    if text == "reroll" {
        return Effect::Reroll;
    }
    if text == "plus1" {
        return Effect::Plus1;
    }
    let a = args(text);
    if text.starts_with("crossAny(") {
        return Effect::CrossAny(match a[0].as_str() {
            "yellow" => CrossTarget::Yellow,
            "blue" => CrossTarget::Blue,
            other => panic!("no cross-any target named {other}"),
        });
    }
    if text.starts_with("crossNext(") {
        assert_eq!(a[0], "green", "only green has a cross-next bonus");
        return Effect::CrossNextGreen;
    }
    if text.starts_with("writeNext(") {
        let target = match a[0].as_str() {
            "orange" => WriteTarget::Orange,
            "purple" => WriteTarget::Purple,
            other => panic!("no write-next target named {other}"),
        };
        let value = a[1].parse::<u8>().expect("a printed number");
        return Effect::WriteNext(target, Face::new(value).expect("a die face"));
    }
    panic!("unknown bonus expression: {text}");
}

/// The `{ index: bonus }` map of a track.
fn cell_bonuses(object: &str) -> Vec<(usize, Effect)> {
    match object.find("cellBonuses:") {
        None => Vec::new(),
        Some(_) => entries(field(object, "cellBonuses", b'{'))
            .into_iter()
            .map(|e| {
                let (index, bonus) = e.split_once(':').expect("index: bonus");
                (index.trim().parse().expect("a cell index"), effect(bonus))
            })
            .collect(),
    }
}

/// One row/column/diagonal of a grid area.
struct Group {
    cells: Vec<usize>,
    bonus: Option<Effect>,
    points: Option<Score>,
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
            points: scalar(g, "points").map(|p| p.parse().expect("printed points")),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Yellow
// ---------------------------------------------------------------------------

#[test]
fn yellow_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "yellow");
    let values = numbers(field(ts, "values", b'['));
    assert_eq!(values.len(), 16, "yellow is a 4×4 grid");

    // Cell for cell: a printed cross is a cell no die can reach, and every
    // other cell answers with the value the sheet prints on it.
    for (i, value) in values.iter().enumerate() {
        let cell = YellowCell::new(i as u8);
        match value {
            None => assert!(cell.is_none(), "cell {i} is a pre-printed cross"),
            Some(v) => assert_eq!(
                cell.expect("a markable cell").value().get(),
                *v as u8,
                "cell {i}"
            ),
        }
    }
    assert_eq!(
        Yellow::new().crossed(),
        values.iter().filter(|v| v.is_none()).count() as u32,
        "the printed crosses are exactly the null cells"
    );

    for group in groups(ts) {
        // Cross the whole group and watch what the last cross fires.
        let mut yellow = Yellow::new();
        let mut fired = Vec::new();
        for &c in &group.cells {
            if let Some(cell) = YellowCell::new(c as u8) {
                fired = yellow.apply(cell).into_iter().collect();
            }
        }
        match group.bonus {
            Some(bonus) => assert!(fired.contains(&bonus), "{:?} → {fired:?}", group.cells),
            None => assert!(fired.is_empty(), "{:?} fired {fired:?}", group.cells),
        }
        assert_eq!(
            yellow.score(),
            group.points.unwrap_or(0),
            "{:?} scores",
            group.cells
        );
    }

    // And the four columns together are the whole score.
    let total: Score = groups(ts).iter().filter_map(|g| g.points).sum();
    assert_eq!(Yellow::from_bits(u16::MAX).score(), total);
}

// ---------------------------------------------------------------------------
// Blue
// ---------------------------------------------------------------------------

#[test]
fn blue_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "blue");
    let values = plain(field(ts, "values", b'['));
    assert_eq!(values.len(), Blue::CELLS);
    for (i, value) in values.iter().enumerate() {
        let cell = BlueCell::new(i as u8).expect("a blue cell");
        assert_eq!(cell.value().get(), *value as u8, "cell {i}");
        assert_eq!(cell, BlueCell::of(cell.value()), "cell {i} round-trips");
    }

    for group in groups(ts) {
        let mut blue = Blue::new();
        let mut fired = Vec::new();
        for &c in &group.cells {
            let cell = BlueCell::new(c as u8).expect("a blue cell");
            fired = blue.apply(cell).into_iter().collect();
        }
        match group.bonus {
            Some(bonus) => assert!(fired.contains(&bonus), "{:?} → {fired:?}", group.cells),
            None => assert!(fired.is_empty(), "{:?} fired {fired:?}", group.cells),
        }
        assert!(group.points.is_none(), "blue scores by count, not by group");
    }

    // Blue scores a table indexed by how many cells are crossed.
    let table = plain(field(ts, "table", b'['));
    let mut blue = Blue::new();
    for (crossed, points) in table.iter().enumerate() {
        assert_eq!(blue.score(), *points as Score, "{crossed} crossed");
        if crossed < Blue::CELLS {
            let _ = blue.apply(BlueCell::new(crossed as u8).expect("a blue cell"));
        }
    }
}

// ---------------------------------------------------------------------------
// Green
// ---------------------------------------------------------------------------

#[test]
fn green_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "green");

    let thresholds = plain(field(ts, "thresholds", b'['));
    assert_eq!(thresholds.len(), Green::CELLS);
    for (i, need) in thresholds.iter().enumerate() {
        let green = Green::from_crossed(i as u8);
        assert_eq!(
            green.needs().expect("room left").get(),
            *need as u8,
            "cell {i}"
        );
    }

    let points = plain(field(ts, "points", b'['));
    for (crossed, want) in points.iter().enumerate() {
        assert_eq!(
            Green::from_crossed(crossed as u8).score(),
            *want as Score,
            "{crossed} crossed"
        );
    }

    let bonuses = cell_bonuses(ts);
    for cell in 0..Green::CELLS {
        let mut green = Green::from_crossed(cell as u8);
        let want = bonuses.iter().find(|(i, _)| *i == cell).map(|(_, e)| *e);
        assert_eq!(green.apply(GreenCross), want, "cell {cell}");
    }
}

// ---------------------------------------------------------------------------
// Orange and purple
// ---------------------------------------------------------------------------

#[test]
fn orange_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "orange");

    let multipliers = plain(field(ts, "multipliers", b'['));
    assert_eq!(multipliers.len(), Orange::SLOTS);
    for (i, mult) in multipliers.iter().enumerate() {
        assert_eq!(Orange::multipliers()[i], *mult as Score, "slot {i}");
        // The multiplier is applied to the die value at scoring time.
        let mut track = Orange::from_faces(&[Face::ONE; Orange::SLOTS][..i]);
        let before = track.score();
        let _ = track.apply(Face::SIX);
        assert_eq!(track.score() - before, 6 * *mult as Score, "slot {i}");
    }

    let bonuses = cell_bonuses(ts);
    for slot in 0..Orange::SLOTS {
        let mut track = Orange::from_faces(&[Face::ONE; Orange::SLOTS][..slot]);
        let want = bonuses.iter().find(|(i, _)| *i == slot).map(|(_, e)| *e);
        assert_eq!(track.apply(Face::SIX), want, "slot {slot}");
    }
}

#[test]
fn purple_matches_the_typescript_sheet() {
    let src = source();
    let ts = area(&src, "purple");

    let size: usize = scalar(ts, "size")
        .expect("a size")
        .parse()
        .expect("a number");
    let reset: u8 = scalar(ts, "resetValue")
        .expect("a reset value")
        .parse()
        .expect("a number");
    assert_eq!(size, Purple::SLOTS);
    assert_eq!(Purple::RESET.get(), reset);

    let bonuses = cell_bonuses(ts);
    // Write 1,2,3,4,5,6,1,… — the greedy ascending run that fills the track.
    let run: Vec<Face> = (0..Purple::SLOTS)
        .map(|i| Face::new((i % 6) as u8 + 1).expect("a die face"))
        .collect();
    for slot in 0..Purple::SLOTS {
        let mut track = Purple::from_faces(&run[..slot]);
        let want = bonuses.iter().find(|(i, _)| *i == slot).map(|(_, e)| *e);
        assert_eq!(track.apply(run[slot]), want, "slot {slot}");
    }
}

// ---------------------------------------------------------------------------
// The variant itself
// ---------------------------------------------------------------------------

#[test]
fn the_variant_matches_the_typescript_sheet() {
    let src = source();
    let ts = bracketed(&src, "export const thatsPrettyClever", b'{');

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
        Some(PrettyClever::ROUNDS.get())
    );
    assert_eq!(
        scalar(ts, "picksPerTurn").and_then(|p| p.parse::<u8>().ok()),
        Some(PrettyClever::PICKS_PER_TURN)
    );
    assert_eq!(scalar(ts, "plus1Scope"), Some("'turn'"));

    // Both printed bars have seven slots, and the sheet has no return bar —
    // which this crate expresses by having no such field at all.
    let bars = field(ts, "bars", b'{');
    for bar in ["reroll", "plus1"] {
        let def = field(bars, bar, b'{');
        assert_eq!(
            scalar(def, "size").and_then(|s| s.parse::<u8>().ok()),
            Some(PrettyClever::BAR_SLOTS),
            "{bar} bar"
        );
        assert_eq!(scalar(def, "endBonus"), Some("null"), "{bar} bar");
    }
    assert_eq!(
        scalar(field(bars, "return", b'{'), "size"),
        Some("0"),
        "the base sheet prints no return bar"
    );

    // The round-4 black bonus, option for option and in printed order.
    let options: Vec<Effect> = entries(field(ts, "options", b'['))
        .into_iter()
        .map(effect)
        .collect();
    let ours: Vec<Effect> = clever_pretty::BlackOption::ALL
        .iter()
        .map(|o| o.effect())
        .collect();
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
    assert_eq!(table.len(), PrettyClever::RATING.len());
    for (i, (min, label)) in table.iter().enumerate() {
        assert_eq!(PrettyClever::RATING[i].min, *min, "rating row {i}");
        assert_eq!(PrettyClever::RATING[i].label, label, "rating row {i}");
    }
}

/// The blue area marks blue + white whichever die is spent — a rule that lives
/// in the variant's `effectiveValue` rather than in any table.
#[test]
fn blue_reads_its_value_from_two_dice() {
    let src = source();
    let ts = area(&src, "blue");
    assert!(
        ts.contains("effectiveValue: (faces) => faces.blue + faces.white"),
        "blue's value is blue + white"
    );
    assert_eq!(Pips::of(Face::THREE, Face::FOUR).get(), 7);
}
