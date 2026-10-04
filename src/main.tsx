import ReactDOM from "react-dom/client";
import "./monaco";
import "./commands";
import "./styles.css";
import App from "./App";

// No StrictMode: its double-mounted effects would create and dispose the Monaco editor twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
