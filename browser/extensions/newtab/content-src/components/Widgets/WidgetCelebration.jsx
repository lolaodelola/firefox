/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import React from "react";

export const WidgetCelebration = ({
  classNamePrefix = "widget-celebration",
  celebrationFrame,
  celebrationId,
  headlineL10nId,
  illustrationSrc,
  onComplete,
  subheadL10nId,
}) => {
  const className = suffix =>
    suffix ? `${classNamePrefix}-${suffix}` : classNamePrefix;
  const resolvedIllustrationSrc = illustrationSrc.endsWith(".svg")
    ? `${illustrationSrc}?run=${celebrationId}`
    : illustrationSrc;
  const strokeSize = celebrationFrame.strokeInset * 2;
  const strokeWidth = celebrationFrame.width - strokeSize;
  const strokeHeight = celebrationFrame.height - strokeSize;

  return (
    <div
      className={className()}
      key={celebrationId}
      role="status"
      aria-live="polite"
      onAnimationEnd={event => {
        if (
          event.target === event.currentTarget &&
          event.animationName === "widget-celebration-lifecycle"
        ) {
          onComplete?.();
        }
      }}
    >
      <div className={className("effects")} aria-hidden="true">
        <svg
          viewBox={`0 0 ${celebrationFrame.width} ${celebrationFrame.height}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient
              id={`${classNamePrefix}-gradient-${celebrationId}`}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="var(--color-orange-20)" />
              <stop offset="28%" stopColor="var(--color-orange-30)" />
              <stop offset="64%" stopColor="var(--color-pink-30)" />
              <stop offset="100%" stopColor="var(--color-pink-40)" />
            </linearGradient>
          </defs>
          <rect
            className={className("stroke-track")}
            x={celebrationFrame.strokeInset}
            y={celebrationFrame.strokeInset}
            width={strokeWidth}
            height={strokeHeight}
            rx={celebrationFrame.radius}
            ry={celebrationFrame.radius}
            pathLength="100"
          />
          <rect
            className={className("stroke")}
            x={celebrationFrame.strokeInset}
            y={celebrationFrame.strokeInset}
            width={strokeWidth}
            height={strokeHeight}
            rx={celebrationFrame.radius}
            ry={celebrationFrame.radius}
            pathLength="100"
            stroke={`url(#${classNamePrefix}-gradient-${celebrationId})`}
          />
          <rect
            className={className("stroke-orbit")}
            x={celebrationFrame.strokeInset}
            y={celebrationFrame.strokeInset}
            width={strokeWidth}
            height={strokeHeight}
            rx={celebrationFrame.radius}
            ry={celebrationFrame.radius}
            pathLength="100"
          />
        </svg>
      </div>
      <div className={className("copy")}>
        <span className={className("headline")} data-l10n-id={headlineL10nId} />
        <span className={className("subhead")} data-l10n-id={subheadL10nId} />
      </div>
      <img
        alt=""
        aria-hidden="true"
        className={className("illustration")}
        src={resolvedIllustrationSrc}
      />
    </div>
  );
};
