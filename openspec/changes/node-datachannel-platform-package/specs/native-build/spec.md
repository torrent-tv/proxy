# native-build — delta spec

## MODIFIED Requirements

### Requirement: node-datachannel is checked, not rebuilt
`scripts/install-native.sh` SHALL check that `node-datachannel` loads from the
package directory and SHALL NOT call `npm rebuild` for it. A binding that
loads SHALL be reported with the package version and the libdatachannel
version; a binding that does not load, or a missing package, SHALL end the
script with a non-zero exit and a `FATAL: install-native:` line.

#### Scenario: Binding loads
- **WHEN** `require("node-datachannel")` from the package directory succeeds
- **THEN** stdout has `install-native: node-datachannel <v>: binding loads
  (libdatachannel <x>)` and the script goes on to the utp-native steps

#### Scenario: Binding does not load
- **WHEN** the require throws
- **THEN** the exit is non-zero, stderr has a FATAL line with the first line of
  the error, and no utp-native step runs

#### Scenario: Package absent
- **WHEN** `node_modules/node-datachannel` does not exist
- **THEN** the exit is non-zero and the FATAL line names `node-datachannel`

#### Scenario: No rebuild
- **WHEN** the script runs
- **THEN** it makes no `npm rebuild` call for `node-datachannel`
