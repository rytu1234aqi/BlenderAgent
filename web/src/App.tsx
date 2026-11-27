import { useState } from "react";
import { WorkbenchApp } from "./WorkbenchApp";
import { Studio } from "./components/studio/Studio";

export default function App() {
  const [mode, setMode] = useState<"studio" | "workbench">("studio");
  if (mode === "workbench") return <WorkbenchApp onSwitchStudio={() => setMode("studio")} />;
  return <Studio onSwitchWorkbench={() => setMode("workbench")} />;
}
