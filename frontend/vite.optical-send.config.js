import { defineConfig } from "vite"
import { createOpticalStandaloneConfig } from "./vite.optical-standalone.config.js"

export default defineConfig(({ mode }) =>
  createOpticalStandaloneConfig({
    mode,
    name: "optical-send",
    entryName: "opticalSend",
    entryFile: "optical-send.html",
    outputDirectory: "../dist/optical-send",
    scalarMode: "optical-send-scalar",
    workerImporterPath: "/utils/optical/",
    inlineWorkerFactoryPath: "utils/optical/worker-factory.inline.ts",
  }),
)
