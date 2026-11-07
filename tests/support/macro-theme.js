// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Supplies editor theme configuration and resource fixtures.
'use strict';
const path = require('node:path');
function themeAPI(files, custom = {}, name = 'Sample') {
  const uri = pathname => ({ path: pathname, toString() { return this.path; } });
  return {
    Uri: { joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts)) },
    extensions: { all: [{ extensionUri: uri('/themes'), packageJSON: { contributes: { themes: [{ id: 'Sample', label: 'Sample label', path: 'child.json' }] } } }] },
    workspace: {
      fs: { readFile: async u => { if (!(u.path in files)) throw Error('Missing theme'); return Buffer.from(files[u.path]); } },
      getConfiguration: section => ({ get: key => section === 'editor' ? custom : key === 'colorTheme' ? name : {} })
    }
  };
}
module.exports = { themeAPI };
