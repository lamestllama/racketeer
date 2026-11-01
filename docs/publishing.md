# Marketplace identity

The extension author and original-code copyright holder are **Eric Parsonage**.
The manifest records that name as `author.name`, beside the `lamestllama`
publisher; the extension guide also shows the full name.

VS Code's publisher label comes from the Marketplace publisher profile. The
manifest's `author.name` does not control that label. In
[Manage Publishers](https://marketplace.visualstudio.com/manage/publishers/),
set the publisher's **Name** to **Eric Parsonage**. The publisher identifier
remains `lamestllama`, so the extension identifier remains
`lamestllama.racketeer` and existing installs retain their identity.

For local VSIX installs without Marketplace publisher metadata, VS Code may
display the publisher identifier. Do not add fabricated installation metadata
or edit the installed extension to override it. Publisher display names are
managed through the Marketplace's supported account settings.

The icon, `racketeer.png`, is the Racket project logo with a badge holding the
debug-continue glyph from Microsoft's Codicons. The logo's source revision,
licence declaration and permission text, and the glyph's CC BY 4.0 credit, are
retained in [the icon notices](../vscode/images/NOTICE.txt).

## Before publishing

Before publishing, recheck that no other Racket extension on the VS Code
Marketplace or Open VSX registers a debugger; the description claims
Racketeer is the only one.

References: [extension manifest](https://code.visualstudio.com/api/references/extension-manifest)
and [publisher setup](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher).
