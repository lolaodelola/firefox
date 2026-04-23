import { render } from "@testing-library/react";
import { WrapWithProvider } from "test/jest/test-utils";
import { LocationSearch } from "content-src/components/Weather/LocationSearch";

describe("<LocationSearch>", () => {
  it("should render", () => {
    const { container } = render(
      <WrapWithProvider>
        <LocationSearch outerClassName="weather" />
      </WrapWithProvider>
    );
    expect(container.querySelector(".location-search")).toBeInTheDocument();
  });
});
