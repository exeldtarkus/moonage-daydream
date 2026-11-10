import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

// scripts/ ada di luar rootDir TS: di-require lewat path runtime dari repo root (out/test -> ../../scripts)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseProfile, profileArgs, detectProfile } = require(path.join(__dirname, '../../scripts/install-local-profile.js'));

test('profileArgs: tanpa profile = tidak ada argumen (profile Default)', () => {
  assert.deepEqual(profileArgs(undefined), []);
  assert.deepEqual(profileArgs(''), []);
  assert.deepEqual(profileArgs('DB'), ['--profile', 'DB']);
});

test('parseProfile: --profile <nama>, --profile=<nama>, lalu env MOONAGE_PROFILE, lalu kosong', () => {
  assert.equal(parseProfile(['--force', '--profile', 'DB'], {}), 'DB');
  assert.equal(parseProfile(['--profile=DB'], {}), 'DB');
  assert.equal(parseProfile(['--force'], { MOONAGE_PROFILE: 'dev' }), 'dev');
  assert.equal(parseProfile(['--profile', 'a'], { MOONAGE_PROFILE: 'b' }), 'a');
  assert.equal(parseProfile([], {}), undefined);
});

const storage = {
  userDataProfiles: [{ location: '-7b8175a1', name: 'DB' }, { location: 'x1', name: 'Other' }],
  profileAssociations: {
    workspaces: {
      'vscode-remote://wsl%2Bubuntu/home/u/ExelFiles/experiment/moonage-daydream': '-7b8175a1',
      'vscode-remote://wsl%2Bubuntu/home/u/other': '__default__profile__',
      'file:///d%3A/proj': 'x1',
    },
  },
};

test('detectProfile: workspace WSL -> nama profile dari storage.json', () => {
  assert.equal(detectProfile(storage, 'Ubuntu', '/home/u/ExelFiles/experiment/moonage-daydream'), 'DB');
});

test('detectProfile: Default / tidak terdaftar / storage kosong = undefined', () => {
  assert.equal(detectProfile(storage, 'Ubuntu', '/home/u/other'), undefined);
  assert.equal(detectProfile(storage, 'Ubuntu', '/home/u/unknown'), undefined);
  assert.equal(detectProfile({}, 'Ubuntu', '/home/u/other'), undefined);
});
