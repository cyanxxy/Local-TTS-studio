import type { ModelToggleDesktopOption } from "../components/ModelToggle";
import {
  DESKTOP_INLINE_ENGINE_IDS,
  ENGINES,
  surfaceEngineDetail,
  type DesktopInlineEngineId,
  type SurfaceEngineSettings,
} from "../models/registry";

/**
 * `badge` and `detail` are optional on `ModelToggleDesktopOption`, but desktop
 * engines always supply both — and have to, because `AdvancedReaderPage`
 * redeclares the same option shape privately with both fields required. Stating
 * the guarantee here is what lets one list feed the toggle and the Reader.
 */
export type DesktopModelOptionData = Omit<ModelToggleDesktopOption, "onSelect">
  & Required<Pick<ModelToggleDesktopOption, "badge" | "detail">>
  & { key: DesktopInlineEngineId };

export type DesktopModelOption = DesktopModelOptionData & Pick<ModelToggleDesktopOption, "onSelect">;

/**
 * Studio and the Reader offer the identical desktop model list; they differ
 * only in which entry is selected and where the selection is recorded, so the
 * caller attaches its own select handler.
 */
export function describeDesktopModelOptions(
  available: Readonly<Record<DesktopInlineEngineId, boolean>>,
  settings: SurfaceEngineSettings,
  selected: DesktopInlineEngineId | null,
): DesktopModelOptionData[] {
  return DESKTOP_INLINE_ENGINE_IDS
    .filter((engine) => available[engine])
    .map((engine) => ({
      key: engine,
      label: ENGINES[engine].label,
      badge: ENGINES[engine].badge,
      detail: surfaceEngineDetail(engine, settings),
      selected: selected === engine,
    }));
}
