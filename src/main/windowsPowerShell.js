"use strict";

// PowerShell 7 prepends its own module directories to PSModulePath. Passing
// that value to Windows PowerShell 5.1 can make built-in modules such as Appx
// and ScheduledTasks fail to load or stall while resolving incompatible
// assemblies. Every Windows PowerShell child gets a clean module search path;
// Windows PowerShell reconstructs its native defaults when the variable is
// absent.
function windowsPowerShellEnvironment(baseEnvironment = process.env, overrides = {}) {
  const environment = { ...baseEnvironment, ...overrides };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  return environment;
}

module.exports = { windowsPowerShellEnvironment };
