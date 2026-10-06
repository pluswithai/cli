#!/usr/bin/env node
import { main } from "./main.js";
import { nodeDeps } from "./node-deps.js";

// exitCode, not exit(): lets stdout/stderr flush before the process ends.
process.exitCode = await main(nodeDeps(process));
