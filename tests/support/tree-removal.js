// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Windows keeps a folder busy for a moment after a process that used it ends, so
// removing one retries, waiting longer each time, for about 20 seconds in all.
module.exports = { recursive: true, force: true, maxRetries: 20, retryDelay: 100 };
