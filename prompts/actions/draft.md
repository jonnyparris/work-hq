Write (or revise) the blog-post draft(s) for this item. Revise in place if a draft path exists.
Voice: {{owner.name}}'s, first person, short sentences, concrete examples, no marketing speak. It's their post,
so you may write as them here. Mark anything you're unsure of with [CHECK: ...].
- Wiki venue ({{wiki.name}}): {{wiki.draftsDir}}/<YYYY-MM-DD>-<slug>.md, plain markdown. Internal detail is fine.
- Site venue ({{site.name}}): {{site.postsDir}}/<slug>.md with frontmatter
  (title, date, description, tags, draft: true). PUBLIC: strip ticket keys, internal hostnames and URLs, colleague
  names, customer names, unreleased product details, incident specifics. Generalise to the idea.
- Both: write both; the site version is the public retelling, not a copy.
Open each draft ({{openFile}}).
Report: update the item with status "proposed", "post": { ...existing, "wikiDraft": "<abs path>", "siteDraft": "<abs path>" },
and a one-line summary of the angle.
