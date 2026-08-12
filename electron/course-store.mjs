import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const COURSE_CACHE_FORMAT = "en-v2-adaptive";

function profileKey(profile) {
  return `${profile?.goal ?? "architecture"}-${profile?.level ?? "adaptive"}`;
}

function cacheKey(repository, profile) {
  return createHash("sha256")
    .update(`${COURSE_CACHE_FORMAT}:${repository.id}:${repository.versionId}:${profileKey(profile)}`)
    .digest("hex")
    .slice(0, 24);
}

export async function saveCourse(courseDirectory, repository, course) {
  await mkdir(courseDirectory, { recursive: true });
  const destination = path.join(courseDirectory, `${cacheKey(repository, course.profile)}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(course, null, 2));
  await rename(temporary, destination);
  return destination;
}

export async function loadCourse(courseDirectory, repository, profile) {
  try {
    const expectedKey = cacheKey(repository, profile);
    const files = await readdir(courseDirectory);
    const match = files.find((file) => file === `${expectedKey}.json`);
    if (!match) return null;
    const course = JSON.parse(await readFile(path.join(courseDirectory, match), "utf8"));
    if (course.repositoryId !== repository.id || course.sourceVersion !== repository.versionId) return null;
    return course;
  } catch {
    return null;
  }
}
