// // Command IDs
export const COMMANDS = {
    MIGRATE: 'libmig.migrate',
    VIEW_TEST_RESULTS: 'libmig.viewTestResults',
    DIFF: 'libmig.viewDiff',
    BACKUP: 'libmig.backup',
    RESTORE: 'libmig.restore',
    HEALTH_CHECK: 'libmig.healthCheck',
    SET_API_KEY: 'libmig.setApiKey',
};

// // Config Keys
export const CONFIG = {
    // // Bools
    MIG_FAILURE_PREVIEW: 'options.previewOnMigrationFailure',
    FORCE_RERUN: 'flags.forceRerun',
    SKIP_TESTS: 'flags.smartSkipTests',
    LIBRARY_SUGGESTIONS: 'options.enableSuggestions.(Experimental)',
    // // Integers
    MAX_FILES: 'flags.maxFileCount',
    // // Enums
    LLM_CLIENT: 'flags.LLMClient',
    PREVIEW_STYLE: 'options.previewGrouping',
    MIG_ROUNDS: 'flags.migrationRounds',
    // // Strings
    PYTHON_VERSION: 'flags.pythonVersion',
    REPO_NAME: 'flags.repositoryName',
    PYTEST_FLAGS: 'options.pytestFlags',
    TEST_ROOT: 'flags.testSuitePath',
    OUTPUT_PATH: 'flags.outputPath',
    REQ_FILE: 'flags.requirementFilePath',
};

// // Telemetry Events
export const TELEMETRY = {
    // // Migration Events
    MIG_START: 'migrationStarted',
    MIG_COMPLETE: 'migrationCompleted',
    MIG_FAIL: 'migrationFailed',
    // // Migration Interactions
    MIG_CANCEL: 'migrationCancelled',
    MIG_APPLY: 'migrationApplied',
    MIG_REJECT: 'migrationRejected'
    // // Usability?
    // e.g. preview style
};
