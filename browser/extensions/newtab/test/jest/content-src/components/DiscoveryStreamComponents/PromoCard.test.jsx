import { render } from "@testing-library/react";
import { WrapWithProvider } from "test/jest/test-utils";
import { PromoCard } from "content-src/components/DiscoveryStreamComponents/PromoCard/PromoCard";

describe("<PromoCard>", () => {
  it("should render", () => {
    const { container } = render(
      <WrapWithProvider>
        <PromoCard />
      </WrapWithProvider>
    );
    expect(container.querySelector(".promo-card-wrapper")).toBeInTheDocument();
  });
});
