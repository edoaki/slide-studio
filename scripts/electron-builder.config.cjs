'use strict';

const base = {
  appId: 'io.github.edoaki.slidestudio',
  productName: 'Slide Studio',
  directories: {
    output: 'release',
  },
  asar: true,
  asarUnpack: [
    'dist/packages/core/assets/**',
  ],
  files: [
    'package.json',
    'LICENSE',
    'NOTICE.md',
    'dist/apps/**',
    'dist/packages/**',
    '!**/*.map',
    '!**/*.ts',
    '!**/*.py',
    '!**/tests/**',
    '!**/fixtures/**',
  ],
  extraResources: [
    {
      from: 'resources/pandoc/targets/${os}-${arch}',
      to: 'pandoc',
    },
  ],
  publish: null,
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['arm64'],
      },
    ],
    category: 'public.app-category.productivity',
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    artifactName: 'Slide-Studio-${version}-mac-${arch}.${ext}',
  },
  dmg: {
    sign: false,
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    signAndEditExecutable: false,
    artifactName: 'Slide-Studio-${version}-win-${arch}-Setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    deleteAppDataOnUninstall: false,
  },
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
};

if (process.env.SLIDE_STUDIO_RELEASE === '1') {
  const { identity: _identity, ...mac } = base.mac;
  module.exports = {
    ...base,
    publish: [{ provider: 'github', owner: 'edoaki', repo: 'slide-studio', releaseType: 'draft' }],
    forceCodeSigning: true,
    mac: { ...mac, target: ['dmg', 'zip'], hardenedRuntime: true, notarize: true },
    win: { ...base.win, signAndEditExecutable: true },
  };
} else {
  module.exports = base;
}
