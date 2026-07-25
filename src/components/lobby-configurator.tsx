"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  areActiveCellsConnected,
  BOARD_SIZE_PRESETS,
  createShapeMask,
  DEFAULT_RULESET,
  DEFAULT_ROUND_DURATION_SECONDS,
  MAXIMUM_BOARD_DIMENSION,
  MAXIMUM_ROUND_DURATION_SECONDS,
  MINIMUM_ACTIVE_CELLS,
  MINIMUM_BOARD_DIMENSION,
  MINIMUM_ROUND_DURATION_SECONDS,
  validateRuleset,
  type BoardShape,
  type GameRuleset,
} from "@/game/ruleset";

import styles from "./game-app.module.css";

export type LobbyConfiguration = {
  ruleset: GameRuleset;
  maxPlayers: number;
};

type LobbyConfiguratorProps = {
  onChange: (configuration: LobbyConfiguration | null) => void;
};

export function LobbyConfigurator({ onChange }: LobbyConfiguratorProps) {
  const [rows, setRows] = useState(4);
  const [columns, setColumns] = useState(4);
  const [shape, setShape] = useState<BoardShape>("rectangle");
  const [dimensionMode, setDimensionMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [durationMode, setDurationMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [duration, setDuration] = useState(DEFAULT_ROUND_DURATION_SECONDS);
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [activeCells, setActiveCells] = useState(() =>
    createShapeMask(4, 4, "rectangle"),
  );
  const shapeEditorRef = useRef<HTMLDivElement>(null);
  const paintingRef = useRef<{
    active: boolean;
    pointerId: number | null;
    value: boolean;
  }>({
    active: false,
    pointerId: null,
    value: true,
  });

  const candidate = useMemo(
    () => ({
      ...DEFAULT_RULESET,
      rows,
      columns,
      shape,
      activeCells,
      roundDurationSeconds: duration,
    }),
    [activeCells, columns, duration, rows, shape],
  );
  const validation = useMemo(() => validateRuleset(candidate), [candidate]);
  const activeCellCount = activeCells.filter(Boolean).length;
  const activeCellsConnected =
    activeCellCount > 0 &&
    areActiveCellsConnected({ rows, columns, activeCells });

  useEffect(() => {
    onChange(
      validation.isValid ? { ruleset: validation.ruleset, maxPlayers } : null,
    );
  }, [maxPlayers, onChange, validation]);

  function normalizeDimension(value: number, fallback: number) {
    if (!Number.isInteger(value)) return fallback;
    return Math.min(
      MAXIMUM_BOARD_DIMENSION,
      Math.max(MINIMUM_BOARD_DIMENSION, value),
    );
  }

  function setDimensions(nextRows: number, nextColumns: number) {
    const normalizedRows = normalizeDimension(nextRows, rows);
    const normalizedColumns = normalizeDimension(nextColumns, columns);
    setRows(normalizedRows);
    setColumns(normalizedColumns);
    setActiveCells(
      shape === "custom"
        ? createShapeMask(normalizedRows, normalizedColumns, "rectangle")
        : createShapeMask(
            normalizedRows,
            normalizedColumns,
            shape as Exclude<BoardShape, "custom">,
          ),
    );
  }

  function setBoardShape(nextShape: BoardShape) {
    setShape(nextShape);
    setActiveCells(
      nextShape === "custom"
        ? createShapeMask(rows, columns, "rectangle")
        : createShapeMask(rows, columns, nextShape),
    );
  }

  function toggleCell(index: number) {
    if (shape !== "custom") return;
    setActiveCells((current) =>
      current.map((active, cellIndex) =>
        cellIndex === index ? !active : active,
      ),
    );
  }

  function paintCell(index: number, value: boolean) {
    if (shape !== "custom") return;
    setActiveCells((current) =>
      current.map((active, cellIndex) =>
        cellIndex === index ? value : active,
      ),
    );
  }

  const squarePreset =
    rows === columns &&
    BOARD_SIZE_PRESETS.includes(rows as (typeof BOARD_SIZE_PRESETS)[number])
      ? String(rows)
      : "custom";

  function finishPainting() {
    const pointerId = paintingRef.current.pointerId;
    if (
      pointerId !== null &&
      shapeEditorRef.current?.hasPointerCapture(pointerId)
    ) {
      shapeEditorRef.current.releasePointerCapture(pointerId);
    }
    paintingRef.current = { active: false, pointerId: null, value: true };
  }

  return (
    <fieldset className={styles.lobbyConfigurator}>
      <legend>Lobby rules</legend>

      <div className={styles.configFields}>
        <label>
          Board
          <select
            value={dimensionMode === "custom" ? "custom" : squarePreset}
            onChange={(event) => {
              if (event.target.value !== "custom") {
                setDimensionMode("preset");
                const size = Number(event.target.value);
                setDimensions(size, size);
              } else {
                setDimensionMode("custom");
              }
            }}
          >
            <option value={BOARD_SIZE_PRESETS[0]}>4 × 4</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        <label>
          Shape
          <select
            value={shape}
            onChange={(event) =>
              setBoardShape(event.target.value as BoardShape)
            }
          >
            <option value="rectangle">Rectangle</option>
            <option value="diamond">Diamond</option>
            <option value="cross">Cross</option>
            <option value="custom">Custom cells</option>
          </select>
        </label>

        <label>
          Round
          <select
            value={durationMode}
            onChange={(event) => {
              const nextMode = event.target.value as "preset" | "custom";
              setDurationMode(nextMode);
              if (nextMode === "preset") {
                setDuration(DEFAULT_ROUND_DURATION_SECONDS);
              }
            }}
          >
            <option value="preset">
              {DEFAULT_ROUND_DURATION_SECONDS} seconds
            </option>
            <option value="custom">Custom</option>
          </select>
        </label>

        <label>
          Maximum players
          <select
            value={maxPlayers}
            onChange={(event) => setMaxPlayers(Number(event.target.value))}
          >
            {Array.from({ length: 11 }, (_, index) => index + 2).map(
              (count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ),
            )}
          </select>
        </label>
      </div>

      {durationMode === "custom" ? (
        <div className={styles.dimensionFields}>
          <label>
            Custom time (seconds)
            <input
              type="number"
              min={MINIMUM_ROUND_DURATION_SECONDS}
              max={MAXIMUM_ROUND_DURATION_SECONDS}
              step={1}
              value={duration}
              onBlur={() =>
                setDuration((current) =>
                  Math.min(
                    MAXIMUM_ROUND_DURATION_SECONDS,
                    Math.max(MINIMUM_ROUND_DURATION_SECONDS, current),
                  ),
                )
              }
              onChange={(event) => setDuration(Number(event.target.value))}
            />
          </label>
        </div>
      ) : null}

      {dimensionMode === "custom" ? (
        <div className={styles.dimensionFields}>
          <label>
            Rows
            <input
              type="number"
              min={MINIMUM_BOARD_DIMENSION}
              max={MAXIMUM_BOARD_DIMENSION}
              value={rows}
              onChange={(event) =>
                setDimensions(Number(event.target.value), columns)
              }
            />
          </label>
          <label>
            Columns
            <input
              type="number"
              min={MINIMUM_BOARD_DIMENSION}
              max={MAXIMUM_BOARD_DIMENSION}
              value={columns}
              onChange={(event) =>
                setDimensions(rows, Number(event.target.value))
              }
            />
          </label>
        </div>
      ) : null}

      <div>
        <div className={styles.shapeHeader}>
          <span>
            {shape === "custom" ? "Tap cells to edit" : "Board preview"}
            {" · "}
            {activeCellCount} included
          </span>
          {shape === "custom" ? (
            <div>
              <button
                type="button"
                onClick={() =>
                  setActiveCells(createShapeMask(rows, columns, "rectangle"))
                }
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() =>
                  setActiveCells(createShapeMask(rows, columns, "rectangle"))
                }
              >
                Fill all
              </button>
              <button
                type="button"
                onClick={() => setActiveCells(activeCells.map(() => false))}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() =>
                  setActiveCells(createShapeMask(rows, columns, "diamond"))
                }
              >
                Diamond
              </button>
              <button
                type="button"
                onClick={() =>
                  setActiveCells(createShapeMask(rows, columns, "cross"))
                }
              >
                Cross
              </button>
            </div>
          ) : null}
        </div>
        <div
          className={styles.shapeEditor}
          ref={shapeEditorRef}
          onPointerMove={(event) => {
            if (!paintingRef.current.active || shape !== "custom") return;
            const target = document
              .elementFromPoint(event.clientX, event.clientY)
              ?.closest<HTMLElement>("[data-shape-cell]");
            const index = Number(target?.dataset.shapeCell);
            if (Number.isInteger(index)) {
              paintCell(index, paintingRef.current.value);
            }
          }}
          onPointerUp={finishPainting}
          onPointerCancel={finishPainting}
          style={
            {
              "--shape-columns": columns,
              aspectRatio: `${columns} / ${rows}`,
            } as React.CSSProperties
          }
        >
          {activeCells.map((active, index) => (
            <button
              aria-label={`Row ${
                Math.floor(index / columns) + 1
              }, column ${(index % columns) + 1}: ${
                active ? "included" : "excluded"
              }`}
              aria-pressed={active}
              className={active ? styles.shapeActive : ""}
              data-shape-cell={index}
              disabled={shape !== "custom"}
              key={index}
              onClick={(event) => {
                if (event.detail === 0) toggleCell(index);
              }}
              onPointerDown={(event) => {
                if (shape !== "custom") return;
                event.preventDefault();
                shapeEditorRef.current?.setPointerCapture(event.pointerId);
                paintingRef.current = {
                  active: true,
                  pointerId: event.pointerId,
                  value: !active,
                };
                paintCell(index, !active);
              }}
              onPointerEnter={() => {
                if (paintingRef.current.active) {
                  paintCell(index, paintingRef.current.value);
                }
              }}
              type="button"
            >
              <span aria-hidden="true">{active ? "✓" : ""}</span>
            </button>
          ))}
        </div>
        <div className={styles.shapeLegend} aria-label="Board cell legend">
          <span>
            <i className={styles.shapeLegendIncluded} aria-hidden="true" />
            Included
          </span>
          <span>
            <i className={styles.shapeLegendExcluded} aria-hidden="true" />
            Excluded
          </span>
        </div>
        <p className={styles.shapeStatus}>
          {rows} × {columns} · {activeCellCount} included · minimum{" "}
          {MINIMUM_ACTIVE_CELLS} ·{" "}
          {activeCellsConnected ? "connected" : "disconnected"}
        </p>
      </div>

      {!validation.isValid ? (
        <p className={styles.configError} role="alert">
          {validation.message}
        </p>
      ) : (
        <p className={styles.configSummary}>
          {activeCellCount} included cells · {duration}s · up to {maxPlayers}{" "}
          players
        </p>
      )}
    </fieldset>
  );
}
