// // Plugin
export const PLUGIN = 'libmig';
export const PLUGIN_TITLE = 'LibMig';
export const ROUNDS = ['premig', 'llmmig', 'merge_skipped', 'async_transform'];
export const ROUND_TITLES = ['Pre-Migration', 'LLM Migration', 'Merge Skipped', 'Async Transform'];
export const ROUND_FOLDERS = ROUNDS.map((round, index) => `${index}-${round}`);

// // Command IDs
export const COMMANDS = {
    MIGRATE: 'libmig.migrate',
    VIEW_TEST_RESULTS: 'libmig.viewTestResults',
    HEALTH_CHECK: 'libmig.healthCheck',
    SET_API_KEY: 'libmig.setApiKey',
};

// // Config Keys
export const CONFIG = {
    // // Bools
    USE_CACHE: 'flags.useCache',
    FORCE_RERUN: 'flags.forceRerun',
    SKIP_TESTS: 'flags.smartSkipTests',
    MIG_FAILURE_PREVIEW: 'options.previewOnMigrationFailure',
    LIBRARY_SUGGESTIONS: 'options.enableSuggestions (Experimental)',
    // // Integers
    MAX_FILES: 'flags.maxFileCount',
    // // Enums
    LLM_CLIENT: 'flags.LLMClient',
    PREVIEW_STYLE: 'options.previewStyle',
    // // Strings
    PYTHON_VERSION: 'flags.pythonVersion',
    REPO_NAME: 'flags.repositoryName',
    TEST_ROOT: 'flags.testRoot',
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
    MIG_REJECT: 'migrationRejected',
    // // Usability?
    // e.g. preview style
};

// // API Key IDs
export const API_KEY_ID = {
    LIBRARIES: 'libmig.librariesioApiKey',
    OPENAI: 'libmig.openaiApiKey',
};
