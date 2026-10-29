import sync from 'i18next-json-sync'

// i18next-json-sync is CJS with a nested default export.
sync.default({
  excludeFiles: ['**/node_modules/**'],
  files: 'electron/resources/extra/common/locales/*.json',
  primary: 'zh-CN',
  lineEndings: 'LF',
  space: 2,
})
