import { render } from "@testing-library/react";
import { WrapWithProvider } from "test/jest/test-utils";
import { _Base as Base } from "content-src/components/Base/Base";

describe("<Base>", () => {
  it("should not render without App.initialized", () => {
    const props = {
      App: { initialized: false },
      Prefs: { values: {} },
      dispatch: jest.fn(),
    };
    const { container } = render(
      <WrapWithProvider>
        <Base {...props} />
      </WrapWithProvider>
    );
    expect(
      container.querySelector(".base-content-fallback")
    ).not.toBeInTheDocument();
  });
});
