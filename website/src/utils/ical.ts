import _ from 'lodash';
import type { EventOption } from 'ical-generator';
import { addDays, addMinutes, addWeeks, isValid } from 'date-fns';

import {
  consumeWeeks,
  EndTime,
  LessonTime,
  Module,
  NumericWeeks,
  RawLesson,
  Semester,
  StartTime,
  WeekRange,
} from 'types/modules';
import { SemTimetableConfigWithLessons } from 'types/timetables';

import config from 'config';
import academicCalendar from 'data/academic-calendar';
import { getExamDate, getExamDuration } from 'utils/modules';
import { getLessonTimeHours, getLessonTimeMinutes, parseDate } from './timify';

const SG_UTC_TIME_DIFF_MS = 8 * 60 * 60 * 1000;
export const RECESS_WEEK = -1;
const NUM_WEEKS_IN_A_SEM = 14; // including reading week
const ODD_WEEKS = [1, 3, 5, 7, 9, 11, 13];
const EVEN_WEEKS = [2, 4, 6, 8, 10, 12];
const ALL_WEEKS = [...ODD_WEEKS, ...EVEN_WEEKS];
const DEFAULT_EXAM_DURATION = 120; // If not provided, assume exams are 2 hours long

function dayIndex(weekday: string) {
  return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].indexOf(weekday.toLowerCase());
}

/**
 * Parse out the hour component from a time string in the format of hhmm
 */
export function getTimeHour(time: LessonTime) {
  return getLessonTimeHours(time) + getLessonTimeMinutes(time) / 60;
}

function addLessonOffset(date: Date, hourOffset: number): Date {
  return addMinutes(date, hourOffset * 60);
}

export function iCalEventForExam(module: Module, semester: Semester): EventOption | null {
  const examDate = getExamDate(module, semester);
  if (!examDate) return null;

  const start = new Date(examDate);
  if (!isValid(start)) return null;

  return {
    start,
    end: addMinutes(start, getExamDuration(module, semester) || DEFAULT_EXAM_DURATION),
    summary: `${module.moduleCode} Exam`,
    description: module.title,
  };
}

export function holidaysForYear(hourOffset = 0): Date[] {
  return config.holidays
    .map((date) => new Date(date.valueOf() - SG_UTC_TIME_DIFF_MS)) // Convert to local time
    .map((holiday) => addLessonOffset(holiday, hourOffset));
}

// given academic weeks in semester and a start date in week 1,
// return dates corresponding to the respective weeks
export function datesForAcademicWeeks(start: Date, week: number): Date {
  // all weeks 7 and after are bumped by 7 days because of recess week
  if (week === RECESS_WEEK) {
    return addWeeks(start, 6);
  }
  return addWeeks(start, week <= 6 ? week - 1 : week);
}

function calculateStartEnd(date: Date, startTime: StartTime, endTime: EndTime) {
  const start = addLessonOffset(date, getTimeHour(startTime));
  const end = addLessonOffset(date, getTimeHour(endTime));

  return { start, end };
}

function calculateLargestInterval(weeks: NumericWeeks) {
  let largestInterval = 1;
  for (let i = 0; i < weeks.length - 1; i++) {
    const diff = weeks[i + 1] - weeks[i];
    if (diff > largestInterval) {
      largestInterval = diff;
    }
  }
  return largestInterval;
}

function isSplitOverRecess(weeks: NumericWeeks) {
  return weeks.some((week) => week <= 6) && weeks.some((week) => week > 6);
}

export function calculateNumericWeek(
  lesson: RawLesson,
  _semester: Semester,
  weeks: NumericWeeks,
  firstDayOfSchool: Date,
): EventOption {
  const lessonDay = addDays(firstDayOfSchool, dayIndex(lesson.day));
  const { start, end } = calculateStartEnd(lessonDay, lesson.startTime, lesson.endTime);
  const excludedWeeks = _.difference([RECESS_WEEK, ...ALL_WEEKS], weeks);

  // Sets interval to 2 for odd and even weeks. Fix for mobile GCal imports.
  const isAlternate =
    weeks.every((week) => ODD_WEEKS.includes(week)) ||
    weeks.every((week) => EVEN_WEEKS.includes(week));
  const interval = isAlternate ? 2 : 1;
  const largestInterval = calculateLargestInterval(weeks);
  const adjCount = ((largestInterval === interval) && !isSplitOverRecess(weeks)) ? weeks.length : NUM_WEEKS_IN_A_SEM;

  return {
    start,
    end,
    repeating: {
      interval,
      freq: 'WEEKLY',
      count: adjCount,
      byDay: [lesson.day.slice(0, 2)],
      exclude: [
        ...excludedWeeks.map((week) => datesForAcademicWeeks(start, week)),
        ...holidaysForYear(getTimeHour(lesson.startTime)),
      ],
    },
  };
}

export function calculateWeekRange(
  lesson: RawLesson,
  _semester: Semester,
  weekRange: WeekRange,
): EventOption {
  const rangeStart = parseDate(weekRange.start);
  const rangeEnd = parseDate(weekRange.end);
  const { start, end } = calculateStartEnd(rangeStart, lesson.startTime, lesson.endTime);

  const interval = weekRange.weekInterval || 1;
  const exclusions = [];

  if (weekRange.weeks) {
    for (
      let current = rangeStart, weekNumber = 1;
      current <= rangeEnd;
      current = addWeeks(current, interval), weekNumber += interval
    ) {
      if (!weekRange.weeks.includes(weekNumber)) {
        const lessonTime = calculateStartEnd(current, lesson.startTime, lesson.endTime);
        exclusions.push(lessonTime.start);
      }
    }
  }

  const lastLesson = calculateStartEnd(rangeEnd, lesson.startTime, lesson.endTime);

  return {
    start,
    end,
    repeating: {
      interval,
      freq: 'WEEKLY',
      until: lastLesson.end,
      byDay: [lesson.day.slice(0, 2)],
      exclude: [...exclusions, ...holidaysForYear(getTimeHour(lesson.startTime))],
    },
  };
}

/**
 * Strategy is to generate a weekly event,
 * then calculate exclusion for special cases in calculateExclusion.
 */
export function iCalEventForLesson(
  lesson: RawLesson,
  module: Module,
  semester: Semester,
  firstDayOfSchool: Date,
): EventOption {
  const event = consumeWeeks(
    lesson.weeks,
    (weeks) => calculateNumericWeek(lesson, semester, weeks, firstDayOfSchool),
    (weeks) => calculateWeekRange(lesson, semester, weeks),
  );

  return {
    ...event,
    summary: `${module.moduleCode} ${lesson.lessonType}`,
    description: `${module.title}\n${lesson.lessonType} Group ${lesson.classNo}`,
    location: lesson.venue,
  };
}

export default function iCalForTimetable(
  semester: Semester,
  timetable: SemTimetableConfigWithLessons,
  moduleData: { [moduleCode: string]: Module },
  hiddenModules: string[],
  academicYear: string = config.academicYear,
): EventOption[] {
  const [year, month, day] = academicCalendar[academicYear][semester].start;
  // 'month - 1' because JS months are zero indexed
  const firstDayOfSchool = new Date(Date.UTC(year, month - 1, day) - SG_UTC_TIME_DIFF_MS);
  const events: EventOption[] = [];

  _.each(timetable, (lessonConfig, moduleCode) => {
    if (hiddenModules.includes(moduleCode)) return;

    _.each(lessonConfig, (lessons) => {
      lessons.forEach((lesson) => {
        // If the lesson is split across recess week, we need to create two separate events for mobile GCal imports as it does not support exclusion rules.
        if (isSplitOverRecess(lesson.weeks) && lesson.weeks.length <= NUM_WEEKS_IN_A_SEM/2) {
          const lessonsFirstHalf = lesson.weeks.slice(0, 6);
          const lessonsSecondHalf = lesson.weeks.slice(6);
          events.push(iCalEventForLesson(lessonsFirstHalf, moduleData[moduleCode], semester, firstDayOfSchool));
          events.push(iCalEventForLesson(lessonsSecondHalf, moduleData[moduleCode], semester, firstDayOfSchool));          
        } else {
          events.push(iCalEventForLesson(lesson, moduleData[moduleCode], semester, firstDayOfSchool));
        }
      });
    });

    const examEvent = iCalEventForExam(moduleData[moduleCode], semester);
    if (examEvent) events.push(examEvent);
  });

  return events;
}
