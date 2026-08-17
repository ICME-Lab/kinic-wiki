use super::*;

pub(super) fn record(counts: &mut AccuracyCounts, expected: bool, actual: bool) {
    match (expected, actual) {
        (true, true) => counts.true_positive += 1,
        (false, false) => counts.true_negative += 1,
        (false, true) => counts.false_positive += 1,
        (true, false) => counts.false_negative += 1,
    }
}

pub(super) fn metrics(counts: AccuracyCounts) -> AccuracyMetrics {
    let precision = ratio(
        counts.true_positive,
        counts.true_positive + counts.false_positive,
    );
    let recall = ratio(
        counts.true_positive,
        counts.true_positive + counts.false_negative,
    );
    let specificity = ratio(
        counts.true_negative,
        counts.true_negative + counts.false_positive,
    );
    let f1 = if precision + recall == 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    };
    AccuracyMetrics {
        counts,
        precision,
        recall,
        specificity,
        f1,
    }
}

pub(super) fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        numerator as f64 / denominator as f64
    }
}
