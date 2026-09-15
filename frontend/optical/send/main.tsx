import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { OpticalSenderStandalone } from "../../components/OpticalSenderStandalone.js"
import "../../style.css"

const rootElement = document.getElementById("root")!
const config = __WRANGLER_CONFIG__

createRoot(rootElement).render(
  <StrictMode>
    <OpticalSenderStandalone config={config} />
  </StrictMode>,
)
