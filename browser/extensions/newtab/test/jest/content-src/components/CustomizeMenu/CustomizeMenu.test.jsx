import { render } from "@testing-library/react";
import { WrapWithProvider } from "test/jest/test-utils";
import { _CustomizeMenu as CustomizeMenu } from "content-src/components/CustomizeMenu/CustomizeMenu";

const DEFAULT_PROPS = {
  dispatch: jest.fn(),
  onOpen: jest.fn(),
  onClose: jest.fn(),
  openPreferences: jest.fn(),
  setPref: jest.fn(),
  showing: false,
  enabledSections: {
    topSitesEnabled: true,
    pocketEnabled: false,
    weatherEnabled: false,
    showInferredPersonalizationEnabled: false,
    topSitesRowsCount: 1,
  },
  enabledWidgets: {
    timerEnabled: false,
    listsEnabled: false,
    widgetsMaximized: false,
    widgetsMayBeMaximized: false,
  },
  wallpapersEnabled: false,
  wallpapersUserEnabled: false,
  activeWallpaper: null,
  pocketRegion: false,
  mayHaveTopicSections: false,
  mayHaveInferredPersonalization: false,
  mayHaveWeather: false,
  mayHaveWidgets: false,
  mayHaveWeatherForecast: false,
  weatherDisplay: "simple",
  mayHaveTimerWidget: false,
  mayHaveListsWidget: false,
  toggleSectionsMgmtPanel: jest.fn(),
  showSectionsMgmtPanel: false,
  toggleWidgetsManagementPanel: jest.fn(),
  showWidgetsManagementPanel: false,
  Prefs: { values: {} },
};

describe("<CustomizeMenu>", () => {
  it("should render", () => {
    const { container } = render(
      <WrapWithProvider>
        <CustomizeMenu {...DEFAULT_PROPS} />
      </WrapWithProvider>
    );
    expect(container.querySelector(".personalize-button")).toBeInTheDocument();
  });
});
