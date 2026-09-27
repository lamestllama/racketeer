# Marketplace identity

The extension author and original-code copyright holder are **Eric Parsonage**.
The manifest records that name and `eric@eparsonage.com`; the extension guide
also shows the full name.

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

The icon is the Racket project logo. Its source revision, licence declaration,
and permission text are retained in [the icon notices](../vscode/images/NOTICE.txt).
That artwork keeps its upstream attribution.

References: [extension manifest](https://code.visualstudio.com/api/references/extension-manifest)
and [publisher setup](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher).
