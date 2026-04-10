import { render } from "@testing-library/react";
import { WrapWithProvider } from "test/jest/test-utils";
import { FocusTimer } from "content-src/components/Widgets/FocusTimer/FocusTimer";

describe("<FocusTimer>", () => {
  it("should render", () => {
    const { container } = render(
      <WrapWithProvider>
        <FocusTimer
          dispatch={jest.fn()}
          handleUserInteraction={jest.fn()}
          isMaximized={false}
          widgetsMayBeMaximized={false}
        />
      </WrapWithProvider>
    );
    expect(container.querySelector(".focus-timer")).toBeInTheDocument();
  });
});
