import { EmptyState } from "../components/shell/EmptyState";
import { Sidebar } from "../components/shell/Sidebar";
import { StatusBar } from "../components/shell/StatusBar";
import { TabBar } from "../components/shell/TabBar";
import { useTabs } from "../stores/tabs";
import { ThemeController } from "./ThemeController";

export function App() {
  const { tabs, activeId, setActive } = useTabs();
  // File opening is wired up in later steps (import + tabs).
  const openFile = () => {};

  return (
    <div className="flex h-full flex-col">
      <ThemeController />
      <TabBar tabs={tabs} activeId={activeId} onSelect={setActive} onOpen={openFile} />
      <div className="flex min-h-0 flex-1">
        <Sidebar tabs={tabs} />
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <EmptyState onOpen={openFile} recent={[]} onOpenRecent={() => {}} />
        </main>
      </div>
      <StatusBar message={tabs.length === 0 ? "Ready" : `${tabs.length} files open`} />
    </div>
  );
}
