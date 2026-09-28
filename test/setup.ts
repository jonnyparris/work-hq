// Tests run on defaults only: never your real config, memory or database.
process.env.WORK_HQ_CONFIG = "none";
process.env.WORK_HQ_SWEEPS = "off";
delete process.env.WORK_HQ_MEMORY_TOKEN;
