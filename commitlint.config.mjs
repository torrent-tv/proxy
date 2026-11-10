// Commit headers: Conventional Commits ending with the task, `<type>(<scope>)!: <subject> #ttv-<issue>`.
// Read by wagoid/commitlint-github-action in the Checks job. No commit is exempt (defaultIgnores: false).
export default {
  extends: ['@commitlint/config-conventional'],
  defaultIgnores: false,
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w+)(?:\(([^()]+)\))?!?: (.+) #ttv-[1-9]\d*$/,
      headerCorrespondence: ['type', 'scope', 'subject'],
    },
  },
};
