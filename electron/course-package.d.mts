/**
 * Types for the shared course-package module, so the browser demo packages and
 * verifies with the same provenance and license rules as the desktop app.
 */
import type { Course, CourseImportResult, CoursePackage, PackageVerification, Repository, SkillGraph } from "../src/types";

export declare const COURSE_PACKAGE_FORMAT: string;
export declare const COURSE_PACKAGE_VERSION: number;
export declare const PERMISSIVE_LICENSES: string[];

export declare function detectLicense(sources?: Record<string, string>): CoursePackage["license"] extends infer L ? { id: string; file: string | null; permissive: boolean; detected: boolean } : never;
export declare function anchorManifest(course: Course, repository: Partial<Repository>): CoursePackage["integrity"]["anchors"];
export declare function packageCourse(
  repository: Partial<Repository>,
  course: Course,
  options?: {
    skillGraph?: SkillGraph | null;
    sources?: Record<string, string>;
    license?: { id: string; file: string | null; permissive: boolean; detected: boolean };
    embedSource?: boolean;
    signature?: CoursePackage["signature"];
    packagedBy?: string;
    now?: string;
  },
): CoursePackage;
export declare function verifyPackage(packaged: CoursePackage, repository: Partial<Repository>): PackageVerification;
export declare function importCourse(packaged: CoursePackage, repository: Partial<Repository>, options?: { force?: boolean }): CourseImportResult;
