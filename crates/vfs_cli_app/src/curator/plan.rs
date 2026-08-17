use super::*;

pub fn validate_plan_file(path: &Path, json: bool) -> Result<()> {
    let plan = read_plan(path)?;
    validate_plan(&plan)?;
    let operation_count = plan
        .proposals
        .iter()
        .map(|proposal| proposal.changes.len())
        .sum::<usize>();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &serde_json::json!({"valid": true, "proposal_count": plan.proposals.len(), "operation_count": operation_count})
            )?
        );
    } else {
        println!(
            "curator plan valid: proposals={} operations={operation_count}",
            plan.proposals.len()
        );
    }
    Ok(())
}
