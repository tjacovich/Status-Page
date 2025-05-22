import { setFailed, setOutput } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { Context } from "@actions/github/lib/context";

import { envsafe, num, str, bool } from "envsafe";
import moment from "moment";
import { ArtifactManager } from "./github/artifact";
import { Repo } from "./github/types";
import { StatusChecker } from "./status";
import { ReportFile } from "./types";
import { generateCoreLogger } from "./util";
import { IncidentManager } from "./github/incidents";

export const env = envsafe({
  SOURCES: str(),
  GITHUB_TOKEN: str(),
  JOB_NAME: str(),
  ARTIFACT_NAME: str({
    default: "report",
    desc: "Name of the artifact file name"
  }),
  AGE_LIMIT: num({
    default: 45,
    desc: "Limit age (in days) of how old can the timestamps be"
  }),
  INCIDENT_LABEL: str({
    default: "incident",
    desc: "Name of the label. Not case sensitive"
  }),
  IGNORE_PREV_ARTIFACT: bool({
    default: true,
  })
});

const getRepo = (ctx: Context): Repo => {

  return ctx.repo;
};

const repo = getRepo(context);

setOutput("repo", `${repo.owner}/${repo.repo}`);

/**
 * Inputs must be in style of
 * ```log
 * site->https://example.com/health
 * site2->https://health.com
 * ```
 * 
 * The `->` is the delimeter between the site name and the url
 */
const sources = env.SOURCES.trim().split("\n").map((line) => line.split("->"));

const logger = generateCoreLogger();
const run = async () => {

  const token = env.GITHUB_TOKEN;
  const api = getOctokit(token);
  const artifactManager = new ArtifactManager(api, logger, env.ARTIFACT_NAME);
  const incidentManager = new IncidentManager(api, logger, env.INCIDENT_LABEL);

  const siteResult: Map<string, ReportFile["site"][number]["status"]> = new Map();

  if (!env.IGNORE_PREV_ARTIFACT) {
    const sourceNames = sources.map(s => s[0]);
    const artifact = await artifactManager.getPreviousArtifact(repo, env.JOB_NAME);
    logger.info(`Found artifact with ${artifact?.site.length ?? 0} elements`);
    if (artifact) {
      logger.info(`Mapping old report`);
      artifact.site.forEach(report => {
        if (sourceNames.includes(report.name)){
          siteResult.set(report.name, report.status);
        }
      });
    }
  } else {
    logger.info('Ignore previous artifact');
  }

  const now = moment().unix();

  // Run tests on each required source
  for (const [name, url, authorization] of sources) {
    const statusChecker = new StatusChecker(name, url, logger, authorization);
    const result = await statusChecker.verifyEndpoint();

    let report: ReportFile["site"][number]["status"] | undefined = siteResult.get(name);

    // Create report if it doesn't exist
    if (!report) {
      report = [];
    }

    // We push the value to the status array
    report.push({ timestamp: now, result });
    siteResult.set(name, report);
  }

  const siteReports: ReportFile["site"] = [];

  for (const [name, report] of siteResult) {
    const beforeCleanLength = report.length;
    // Clean old timestamp reports
    const cleanedStatus = report.filter(({ timestamp }) => Math.abs(moment.unix(timestamp).diff(moment.now(), "days")) < env.AGE_LIMIT);

    if (cleanedStatus.length !== beforeCleanLength) {
      logger.debug(`Removed ${beforeCleanLength - cleanedStatus.length} elements from '${name}'`);
    }

    if (cleanedStatus.length === 0) {
      // We delete empty entries
      siteResult.delete(name);
      logger.info(`Deleted report for '${name}' because it's empty`)
    } else {
      logger.info(`'${name}' status has ${cleanedStatus.length} status`);
      siteReports.push({ name, status: cleanedStatus });
    }
  }

  const incidents = await incidentManager.obtainPastIncidents(repo, env.AGE_LIMIT);

  const report: ReportFile = { incidents, site: siteReports }

  const file = await artifactManager.generateArtifact(report);
  setOutput("file", file);
}

run().catch(setFailed);
