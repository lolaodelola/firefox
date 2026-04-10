import { render } from "@testing-library/react";
import { WrapWithProvider } from "test/jest/test-utils";
import { Lists } from "content-src/components/Widgets/Lists/Lists";

describe("<Lists>", () => {
  it("should render", () => {
    const { container } = render(
      <WrapWithProvider>
        <Lists
          dispatch={jest.fn()}
          handleUserInteraction={jest.fn()}
          isMaximized={false}
          widgetsMayBeMaximized={false}
        />
      </WrapWithProvider>
    );
    expect(container.querySelector(".lists")).toBeInTheDocument();
  });
});
