# Prompts

Every instruction a pi session gets from Work HQ that is **about your tools or your company** lives here as
plain markdown. The parts the server parses (output JSON shapes, the report contract) stay in
`src/server/prompts.ts` so they can't drift from the code.

Override any file by copying it into your own folder and pointing `promptsDir` at it in your config.
Missing files fall back to these defaults, so you only copy the ones you change.

`{{placeholders}}` are filled from your config. Available everywhere:

| Placeholder | From |
|---|---|
| `{{owner.name}}` `{{owner.role}}` `{{owner.company}}` `{{owner.intro}}` `{{owner.timezone}}` | `owner` |
| `{{workspace.dir}}` `{{workspace.scratchDir}}` | `workspace` |
| `{{tracker}}` `{{chat}}` | `labels` |
| `{{wiki.name}}` `{{wiki.draftsDir}}` `{{site.name}}` `{{site.postsDir}}` `{{site.repoDir}}` | `writing` |
| `{{openFile}}` | how to open a file for the user (Obsidian URL or `open`) |
| `{{whq}}` `{{port}}` `{{root}}` | the running app |

Some files get extra ones (`{{since}}`, `{{day}}`, `{{known}}`, …) — see the comment at the top of each.
Lines starting with `<!--` … `-->` are stripped before the prompt is sent.
