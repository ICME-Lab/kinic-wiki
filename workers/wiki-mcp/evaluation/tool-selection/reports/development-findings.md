# Development findings (before holdout)

1. Cross-database URLs: A used two `read_path` calls in all four initial runs.
   B without the skill used one `fetch_many`, but B with the skill used two
   path calls; C with the skill also split one run. The existing skill lists
   fetch_many only after search, leaving user-provided URLs insufficiently clear.
2. Broad investigation: all variants make invalid `limit: 100`/`200` attempts,
   although search permits 20 and list 99. Example server error from B:
   > MCP error -32602: Input validation error: Invalid arguments for tool search: Too big: expected number to be <=20 at limit
   B's first investigation made three invalid requests, retried within limits,
   then read the evidence. This is a recoverable input-selection problem.

Refinement r1 changes only how existing limits are described (tool description,
parameter description, server instructions, skill/reference). It does not change
limits or retrieval behavior. Refinement r2 addressed known URLs
as a separate routing clarification. Expected outputs and labels stay frozen.

## Completed development checks

r1's eight paired B/C investigation runs reduced mean calls from 8.375 to 5.5
and input errors from 19 to zero. r2's eight paired URL runs reduced mean calls
from 1.375 to 1.0. The final full r2 development run passed 192/192, with no unsafe
operations. B/C had zero input errors; A had nine. Labels were unchanged.

These observations were fixed before holdout. The final selection is in
[RESULTS.md](RESULTS.md); there was no third refinement or holdout tuning.
