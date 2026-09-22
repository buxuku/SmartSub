import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readConfigDraft,
  writeConfigDraft,
  readCueDraft,
  writeCueDraft,
} from '../../main/helpers/dubbing/configDraftStore';
import { setDubbingSessionsRoot } from '../../main/helpers/dubbing/sessionStore';
import {
  DEFAULT_DUBBING_PREFERENCES,
  parseDubbingConfigDraft,
} from '../../types/dubbingConfigDraft';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'smartsub-dubbing-journal-'),
);
setDubbingSessionsRoot(root);
const draft = (revision: number, speed: number) =>
  JSON.stringify({
    version: 1,
    revision,
    sessionId: 'project',
    saved: DEFAULT_DUBBING_PREFERENCES,
    current: { ...DEFAULT_DUBBING_PREFERENCES, globalSpeed: speed },
  });
const first = draft(1, 1.1),
  second = draft(2, 1.2);
assert.equal(readConfigDraft('project'), null);
assert.equal(writeConfigDraft('project', null, first), first);
assert.equal(readConfigDraft('project'), first);
assert.equal(
  writeConfigDraft('project', null, first),
  first,
  'replayed write after a lost acknowledgement',
);
assert.equal(writeConfigDraft('project', first, second), second);
assert.throws(() => writeConfigDraft('project', first, null), /another editor/);
assert.throws(
  () => writeConfigDraft('project', first, draft(3, 1.3)),
  /another editor/,
);
assert.throws(() => writeConfigDraft('other', null, first), /another project/);
assert.throws(
  () => writeConfigDraft('project', second, draft(3, 9)),
  /Invalid dubbing/,
);
assert.throws(() => writeConfigDraft('project', second, '{bad'));
assert.equal(readConfigDraft('project'), second);
const rename = fs.renameSync;
fs.renameSync = () => {
  throw new Error('Injected rename failure');
};
try {
  assert.throws(
    () => writeConfigDraft('project', second, draft(3, 1.3)),
    /rename failure/,
  );
} finally {
  fs.renameSync = rename;
}
assert.equal(readConfigDraft('project'), second);
assert.equal(
  fs
    .readdirSync(path.join(root, '.config-drafts'))
    .filter((name) => name.endsWith('.tmp')).length,
  0,
);
const sync = fs.fsyncSync;
fs.fsyncSync = () => {
  throw new Error('Injected fsync failure');
};
try {
  assert.throws(
    () => writeConfigDraft('project', second, draft(3, 1.3)),
    /fsync failure/,
  );
} finally {
  fs.fsyncSync = sync;
}
assert.equal(readConfigDraft('project'), second);
assert.equal(writeConfigDraft('project', second, null), null);
assert.equal(
  writeConfigDraft('project', second, null),
  null,
  'replayed deletion',
);
assert.equal(readConfigDraft('project'), null);
const strange = JSON.stringify({
  ...JSON.parse(first),
  sessionId: '../../outside',
});
writeConfigDraft('../../outside', null, strange);
assert.equal(fs.readdirSync(path.join(root, '.config-drafts')).length, 1);
assert.equal(fs.existsSync(path.join(root, '..', 'outside')), false);
const file = path.join(
  root,
  '.config-drafts',
  fs.readdirSync(path.join(root, '.config-drafts'))[0],
);
fs.writeFileSync(file, '{corrupt');
assert.equal(readConfigDraft('../../outside'), '{corrupt');
assert.throws(() => parseDubbingConfigDraft('{corrupt', '../../outside'));
assert.equal(writeConfigDraft('../../outside', '{corrupt', null), null);
const cueDraft = JSON.stringify({
  version: 1,
  revision: 1,
  sessionId: 'cue-project',
  entries: [
    { index: 0, startMs: 0, endMs: 1000, baseText: 'Before', text: '' },
  ],
});
assert.equal(writeCueDraft('cue-project', null, cueDraft), cueDraft);
assert.equal(writeCueDraft('cue-project', null, cueDraft), cueDraft);
assert.equal(readCueDraft('cue-project'), cueDraft);
assert.equal(readConfigDraft('cue-project'), null);
assert.throws(() => writeCueDraft('other', null, cueDraft), /another project/);
assert.throws(() => writeCueDraft('cue-project', null, null), /another editor/);
assert.throws(() =>
  writeCueDraft(
    'cue-project',
    cueDraft,
    JSON.stringify({ ...JSON.parse(cueDraft), entries: [null] }),
  ),
);
assert.equal(readCueDraft('cue-project'), cueDraft);
assert.equal(writeCueDraft('cue-project', cueDraft, null), null);
console.log(
  JSON.stringify({
    root,
    checks:
      'atomic journal, fsync/rename rejection rollback, private-file cleanup, CAS, lost acknowledgement replay, malformed data retention, scope/path isolation',
  }),
);
