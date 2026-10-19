"use client";

import { useState, type FormEvent } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { FormError } from "@/components/menu-admin/form-dialog";
import { IconButton } from "@/components/menu-admin/icon-button";
import { useMenuAction } from "@/components/menu-admin/use-menu-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { inputStyles } from "@/components/ui/input";
import { saveWeekHoursAction } from "@/modules/restaurant-settings/actions";
import {
  MAX_INTERVALS_PER_DAY,
  WEEKDAYS,
  cloneWeek,
  isOvernight,
  sameWeek,
  toMinutes,
  validateWeek,
  weekFromRows,
  type WeekHours,
} from "@/modules/restaurant-settings/hours";
import type { HourRow } from "@/modules/restaurant-settings/types";
import { SaveBar } from "./fields";

type HoursEditorProps = {
  slug: string;
  hours: HourRow[];
  timezoneLabel: string;
};

function nextInterval(day: WeekHours[number]): { opens: string; closes: string } {
  const last = day[day.length - 1];
  if (!last) return { opens: "11:00", closes: "23:00" };
  // Começa uma hora depois do último fechamento (sem passar da meia-noite).
  const start = Math.min(toMinutes(last.closes) + 60, 22 * 60);
  const hh = String(Math.floor(start / 60)).padStart(2, "0");
  const mm = String(start % 60).padStart(2, "0");
  return { opens: `${hh}:${mm}`, closes: "23:00" };
}

/** Seção "Horários de funcionamento": vários intervalos por dia, virada de dia e dia fechado. */
export function HoursEditor({ slug, hours, timezoneLabel }: HoursEditorProps) {
  const { run, pending } = useMenuAction();
  const [saved, setSaved] = useState(() => weekFromRows(hours));
  const [week, setWeek] = useState(() => cloneWeek(saved));
  const [formError, setFormError] = useState<string | null>(null);

  const problem = validateWeek(week);
  const dirty = !sameWeek(week, saved);
  const anyOpen = week.some((day) => day.length > 0);

  function update(weekday: number, mutate: (day: WeekHours[number]) => WeekHours[number]) {
    setWeek((current) => current.map((day, index) => (index === weekday ? mutate(day) : day)));
  }

  function setTime(weekday: number, index: number, field: "opens" | "closes", value: string) {
    update(weekday, (day) => day.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function copyToOthers(weekday: number) {
    setWeek((current) =>
      current.map((day, index) => (index === weekday ? day : current[weekday].map((item) => ({ ...item })))),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem) {
      setFormError(problem.message);
      return;
    }
    setFormError(null);
    const result = await run(() => saveWeekHoursAction(slug, week), { inlineError: true });
    if (result.ok) setSaved(cloneWeek(week));
    else setFormError(result.message);
  }

  return (
    <Card aria-labelledby="hours-title">
      <CardHeader
        title={<span id="hours-title">Horários de funcionamento</span>}
        description={`Os horários seguem o fuso ${timezoneLabel}. Um dia sem intervalos fica fechado. Para fechar depois da meia-noite, use um fechamento menor que a abertura (ex.: 18:00 às 02:00).`}
      />
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <ul className="flex flex-col divide-y divide-line">
          {WEEKDAYS.map(({ value: weekday, label }) => {
            const day = week[weekday];
            const dayProblem = problem?.weekday === weekday ? problem.message : null;
            return (
              <li key={weekday} className="grid gap-3 py-4 first:pt-0 md:grid-cols-[10rem_1fr]">
                <div className="flex items-center gap-2 md:block">
                  <h3 className="text-sm font-semibold text-fg">{label}</h3>
                  {day.length === 0 ? <Badge className="md:mt-1">Fechado</Badge> : null}
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                  {day.map((interval, index) => (
                    <div key={index} className="flex flex-wrap items-end gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted" htmlFor={`h-${weekday}-${index}-o`}>
                          Abre
                          <span className="sr-only">
                            {" "}
                            ({label}, intervalo {index + 1})
                          </span>
                        </label>
                        <input
                          id={`h-${weekday}-${index}-o`}
                          type="time"
                          required
                          value={interval.opens}
                          onChange={(event) => setTime(weekday, index, "opens", event.target.value)}
                          className={inputStyles(false, "w-32")}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted" htmlFor={`h-${weekday}-${index}-c`}>
                          Fecha
                          <span className="sr-only">
                            {" "}
                            ({label}, intervalo {index + 1})
                          </span>
                        </label>
                        <input
                          id={`h-${weekday}-${index}-c`}
                          type="time"
                          required
                          value={interval.closes}
                          onChange={(event) => setTime(weekday, index, "closes", event.target.value)}
                          className={inputStyles(false, "w-32")}
                        />
                      </div>
                      {interval.opens && interval.closes && isOvernight(interval) ? (
                        <Badge tone="info" className="mb-2.5">
                          Fecha no dia seguinte
                        </Badge>
                      ) : null}
                      <IconButton
                        label={`Remover intervalo ${index + 1} de ${label}`}
                        onClick={() => update(weekday, (items) => items.filter((_, i) => i !== index))}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </IconButton>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    {day.length < MAX_INTERVALS_PER_DAY ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => update(weekday, (items) => [...items, nextInterval(items)])}
                      >
                        <Plus aria-hidden="true" className="size-4" />
                        {day.length === 0 ? "Abrir neste dia" : "Adicionar intervalo"}
                      </Button>
                    ) : null}
                    {day.length > 0 ? (
                      <Button variant="ghost" size="sm" onClick={() => copyToOthers(weekday)}>
                        <Copy aria-hidden="true" className="size-4" />
                        Copiar para todos os dias
                      </Button>
                    ) : null}
                  </div>
                  {dayProblem ? (
                    <p role="alert" className="text-sm font-medium text-danger">
                      {dayProblem}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {!anyOpen ? (
          <p className="text-sm text-muted">
            Sem nenhum horário cadastrado, a vitrine mostra o restaurante como fechado.
          </p>
        ) : null}
        <FormError message={formError} />
        <SaveBar
          dirty={dirty}
          pending={pending}
          label="Salvar horários"
          disabled={problem !== null}
          onDiscard={() => {
            setWeek(cloneWeek(saved));
            setFormError(null);
          }}
        />
      </form>
    </Card>
  );
}
