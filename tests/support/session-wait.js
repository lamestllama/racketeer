// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const { until } = require('./wait');

function sessionWait(messages, ended, relative) {
  return (session, check, description) => {
    const named = `${relative(session)}: ${description}`;
    const history = () => messages.filter(message => message.session.id === session.id);
    const details = () => JSON.stringify(history());
    return until(() => {
      const own = history();
      const result = check(own);
      if (result) return result;
      if (ended.has(session.id) || own.some(message => message.event === 'terminated' ||
          (message.type === 'response' && message.command === 'launch' && message.success === false))) {
        throw new Error(`Session ended before ${named}: ${details()}`);
      }
    }, named, details);
  };
}

module.exports = { sessionWait };
