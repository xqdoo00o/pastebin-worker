import { defineConfig } from "vite"
import { createOpticalStandaloneConfig } from "./vite.optical-standalone.config.js"

export default defineConfig(({ mode }) =>
  createOpticalStandaloneConfig({
    mode,
    name: "optical-receive",
    entryName: "opticalReceive",
    entryFile: "optical-receive.html",
    outputDirectory: "../dist/optical-receive",
    scalarMode: "optical-receive-scalar",
    workerImporterPath: "/optical/receive/",
    inlineWorkerFactoryPath: "optical/receive/worker-factory.inline.ts",
  }),
)
