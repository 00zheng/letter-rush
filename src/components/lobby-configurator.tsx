"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  BOARD_SIZE_PRESETS,
  createShapeMask,
  DEFAULT_RULESET,
  MAXIMUM_BOARD_DIMENSION,
  MINIMUM_BOARD_DIMENSION,
  ROUND_DURATION_OPTIONS,
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
  const [duration, setDuration] = useState(60);
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [activeCells, setActiveCells] = useState(() =>
    createShapeMask(4, 4, "rectangle"),
  );
  const paintingRef = useRef<{ active: boolean; value: boolean }>({
    active: false,
    value: true,
  });

  const candidate = useMemo(
    () => ({
      ...DEFAULT_RULESET,
      rows,
      columns,
      shape,
      activeCells,
      roundDurationSeconds: duration as (typeof ROUND_DURATION_OPTIONS)[number],
    }),
    [activeCells, columns, duration, rows, shape],
  );
  const validation = useMemo(() => validateRuleset(candidate), [candidate]);

  useEffect(() => {
    onChange(
      validation.isValid ? { ruleset: validation.ruleset, maxPlayers } : null,
    );
  }, [maxPlayers, onChange, validation]);

  function setDimensions(nextRows: number, nextColumns: number) {
    setRows(nextRows);
    setColumns(nextColumns);
    setActiveCells(
      shape === "custom"
        ? createShapeMask(nextRows, nextColumns, "rectangle")
        : createShapeMask(
            nextRows,
            nextColumns,
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

  return (
    <fieldset className={styles.lobbyConfigurator}>
      <legend>Lobby rules</legend>

      <div className={styles.configFields}>
        <label>
          Board preset
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
            {BOARD_SIZE_PRESETS.map((size) => (
              <option key={size} value={size}>
                {size} × {size}
              </option>
            ))}
            <option value="custom">Custom rectangle</option>
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
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
          >
            {ROUND_DURATION_OPTIONS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds} seconds
              </option>
            ))}
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
            {activeCells.filter(Boolean).length} active
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
          onPointerUp={() => {
            paintingRef.current.active = false;
          }}
          onPointerCancel={() => {
            paintingRef.current.active = false;
          }}
          onPointerLeave={() => {
            paintingRef.current.active = false;
          }}
          style={
            {
              "--shape-columns": columns,
              aspectRatio: `${columns} / ${rows}`,
            } as React.CSSProperties
          }
        >
          {activeCells.map((active, index) => (
            <button
              aria-label={`${active ? "Deactivate" : "Activate"} row ${
                Math.floor(index / columns) + 1
              }, column ${(index % columns) + 1}`}
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
                paintingRef.current = { active: true, value: !active };
                paintCell(index, !active);
              }}
              onPointerEnter={() => {
                if (paintingRef.current.active) {
                  paintCell(index, paintingRef.current.value);
                }
              }}
              type="button"
            />
          ))}
        </div>
      </div>

      {!validation.isValid ? (
        <p className={styles.configError} role="alert">
          {validation.message}
        </p>
      ) : (
        <p className={styles.configSummary}>
          {activeCells.filter(Boolean).length} active cells · {duration}s · up
          to {maxPlayers} players
        </p>
      )}
    </fieldset>
  );
}
