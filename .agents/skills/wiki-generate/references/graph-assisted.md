# Graph-Assisted Drafting

Graph-assisted tooling such as `graphify` is optional in this repo.

## Allowed Role

Use graph assistance only for:

- discovering topic clusters
- proposing candidate pages
- suggesting relationships between pages
- producing an initial page map

## Disallowed Role

Do not use graph assistance as:

- the source of truth
- the revision manager
- the sync engine
- the final authority on page boundaries
- the final published wiki

## Recommended Position In The Flow

If graph assistance is used, it belongs between:

- `Source Intake`
- and `Page Map`

That means:

1. inspect source material
2. optionally run graph assistance
3. produce a page map
4. write draft pages into `Wiki/`
5. review in Obsidian
6. push only after review

## Practical Rule

Use graph assistance when the input set is large or relationship-heavy.

Do not use it when:

- there are only a few files
- the user already knows the target page structure
- direct drafting is simpler

## Output Expectations

The useful output from graph assistance is:

- a page map
- candidate links
- suggested page splits or merges

The useful output is not:

- a final wiki that bypasses review
- a direct replacement for local draft writing
