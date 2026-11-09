export type Role = 'admin' | 'coordinator' | 'professor';
export type Section = 'past' | 'present' | 'future';
export type Status = 'not_started' | 'in_progress' | 'complete';
export type AccessLevel = 'admin' | 'coordinator' | 'faculty';

export const SECTIONS: { key: Section; label: string }[] = [
  { key: 'past', label: 'Past' },
  { key: 'present', label: 'Present' },
  { key: 'future', label: 'Future' },
];

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  isFaculty: boolean;
  active: boolean;
  timezone: string;
}

export interface Curriculum {
  id: number;
  name: string;
  archived: boolean;
}
export interface Major {
  id: number;
  curriculumId: number;
  name: string;
  archived: boolean;
}
export interface Review {
  id: number;
  majorId: number;
  title: string;
  period: string;
  description: string;
  archived: boolean;
  myAccess?: AccessLevel;
  createdAt: string;
}

export interface Task {
  id: number;
  reviewId: number;
  section: Section;
  parentId: number | null;
  title: string;
  instructions: string;
  assigneeId: number | null;
  dueDate: string | null;
  status: Status;
  sortOrder: number;
  currentRevisionNo: number;
  wordCount: number;
  completedAt: string | null;
  completedBy: number | null;
  reopenedAt: string | null;
  reopenedBy: number | null;
  archived: boolean;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
}

export type UserNames = Record<number, { displayName: string; active: boolean }>;

export interface FacultyMember {
  id: number;
  displayName: string;
  active: boolean;
  isFaculty: boolean;
  role: Role;
  assignable: boolean;
}

export interface ResponseRevision {
  revisionNo: number;
  html: string;
  wordCount: number;
  authorId: number | null;
  authorName: string | null;
  createdAt: string | null;
  restoredFromRevisionNo?: number | null;
}

export type Run = { text: string; bold?: boolean; italic?: boolean; br?: boolean };
export type Block =
  | { type: 'p'; runs: Run[] }
  | { type: 'li'; ordered: boolean; level: number; num: number; runs: Run[] };

export interface ReportNode {
  taskId: number;
  depth: number;
  outline: string;
  title: string;
  status: Status;
  assignee: string | null;
  kind: 'narrative' | 'draft' | 'missing' | 'context';
  revisionNo: number | null;
  blocks: Block[];
}

export interface ReportContent {
  reviewId: number;
  title: string;
  curriculum: string;
  major: string;
  period: string;
  generatedAt: string;
  generatedAtLabel: string;
  generatedBy: string;
  mode: 'working' | 'completed';
  options: { attribution: boolean };
  progress: { completed: number; total: number };
  counts: {
    unassigned: number;
    notStarted: number;
    inProgress: number;
    complete: number;
    includedNarratives: number;
    excludedTasks: number;
    unfinishedTasks: number;
  };
  allComplete: boolean;
  unresolved: { taskId: number; section: Section; path: string[]; status: Status; assignee: string | null }[];
  sections: { key: Section; label: string; nodes: ReportNode[] }[];
}

export interface SnapshotSummary {
  id: number;
  reviewId: number;
  mode: 'working' | 'completed';
  options: { attribution: boolean };
  activeTaskCount: number;
  completedTaskCount: number;
  createdAt: string;
  createdBy: string;
}
