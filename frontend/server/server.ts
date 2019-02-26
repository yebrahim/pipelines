// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as Storage from '@google-cloud/storage';
import * as express from 'express';
import * as fs from 'fs';
import * as k8sHelper from './k8s-helper';
import * as path from 'path';
import * as process from 'process';
import * as proxy from 'http-proxy-middleware';
import * as tar from 'tar';
import RunUtils from '../src/lib/RunUtils';
import fetch from 'node-fetch';
import proxyMiddleware from './proxy-middleware';
import { ApiRun, ApiRunDetail } from '../src/apis/run';
import { Apis } from '../src/lib/Apis';
import { Application, static as StaticHandler } from 'express';
import { Client as MinioClient } from 'minio';
import { Stream } from 'stream';
import { Workflow } from '../third_party/argo-ui/argo_template';
import { errorToMessage } from '../src/lib/Utils';

const BASEPATH = '/pipeline';

interface ExperimentInfo {
  displayName?: string;
  id: string;
}

interface PipelineInfo {
  displayName?: string;
  id?: string;
  runId?: string;
  showLink: boolean;
}

interface DisplayRun {
  experiment?: ExperimentInfo;
  metadata: ApiRun;
  pipeline?: PipelineInfo;
  workflow?: Workflow;
  error?: string;
}

// The minio endpoint, port, access and secret keys are hardcoded to the same
// values used in the deployment.
const minioClient = new MinioClient({
  accessKey: 'minio',
  endPoint: 'minio-service.kubeflow',
  port: 9000,
  secretKey: 'minio123',
  useSSL: false,
} as any);

const app = express() as Application;

app.use(function (req, _, next) {
  console.info(req.method + ' ' + req.originalUrl);
  next();
});

if (process.argv.length < 3) {
  console.error(`\
Usage: node server.js <static-dir> [port].
       You can specify the API server address using the
       ML_PIPELINE_SERVICE_HOST and ML_PIPELINE_SERVICE_PORT
       env vars.`);
  process.exit(1);
}

const currentDir = path.resolve(__dirname);
const buildDatePath = path.join(currentDir, 'BUILD_DATE');
const commitHashPath = path.join(currentDir, 'COMMIT_HASH');

const staticDir = path.resolve(process.argv[2]);
const buildDate =
  fs.existsSync(buildDatePath) ? fs.readFileSync(buildDatePath, 'utf-8').trim() : '';
const commitHash =
  fs.existsSync(commitHashPath) ? fs.readFileSync(commitHashPath, 'utf-8').trim() : '';
const port = process.argv[3] || 3000;
const apiServerHost = process.env.ML_PIPELINE_SERVICE_HOST || 'localhost';
const apiServerPort = process.env.ML_PIPELINE_SERVICE_PORT || '3001';
const apiServerAddress = `http://${apiServerHost}:${apiServerPort}`;

const v1beta1Prefix = 'apis/v1beta1';
const middlewarePrefix = 'middleware/v1beta1';

const healthzStats = {
  apiServerCommitHash: '',
  apiServerReady: false,
  buildDate,
  frontendCommitHash: commitHash,
};

const healthzHandler = async (_, res) => {
  try {
    const response = await fetch(
      `${apiServerAddress}/${v1beta1Prefix}/healthz`, { timeout: 1000 });
    healthzStats.apiServerReady = true;
    const serverStatus = await response.json();
    healthzStats.apiServerCommitHash = serverStatus.commit_sha;
  } catch (e) {
    healthzStats.apiServerReady = false;
  }
  res.json(healthzStats);
};

const artifactsHandler = async (req, res) => {
  const [source, bucket, encodedKey] = [req.query.source, req.query.bucket, req.query.key];
  if (!source) {
    res.status(500).send('Storage source is missing from artifact request');
    return;
  }
  if (!bucket) {
    res.status(500).send('Storage bucket is missing from artifact request');
    return;
  }
  if (!encodedKey) {
    res.status(500).send('Storage key is missing from artifact request');
    return;
  }
  const key = decodeURIComponent(encodedKey);
  console.log(`Getting storage artifact at: ${source}: ${bucket}/${key}`);
  switch (source) {
    case 'gcs':
      try {
        // Read all files that match the key pattern, which can include wildcards '*'.
        // The way this works is we list all paths whose prefix is the substring
        // of the pattern until the first wildcard, then we create a regular
        // expression out of the pattern, escaping all non-wildcard characters,
        // and we use it to match all enumerated paths.
        const storage = Storage();
        const prefix = key.indexOf('*') > -1 ? key.substr(0, key.indexOf('*')) : key;
        const files = await storage.bucket(bucket).getFiles({ prefix });
        const matchingFiles = files[0].filter((f) => {
          // Escape regex characters
          const escapeRegexChars = (s: string) => s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
          // Build a RegExp object that only recognizes asterisks ('*'), and
          // escapes everything else.
          const regex = new RegExp('^' + key.split(/\*+/).map(escapeRegexChars).join('.*') + '$');
          return regex.test(f.name);
        });

        if (!matchingFiles.length) {
          console.log('No matching files found.');
          res.send();
          return;
        }
        console.log(`Found ${matchingFiles.length} matching files:`, matchingFiles);
        let contents = '';
        matchingFiles.forEach((f, i) => {
          const buffer: Buffer[] = [];
          f.createReadStream()
            .on('data', (data) => buffer.push(data))
            .on('end', () => {
              contents += Buffer.concat(buffer).toString().trim() + '\n';
              if (i === matchingFiles.length - 1) {
                res.send(contents);
              }
            })
            .on('error', () => res.status(500).send('Failed to read file: ' + f.name));
        });
      } catch (err) {
        res.status(500).send('Failed to download GCS file(s). Error: ' + err);
      }
      break;
    case 'minio':
      minioClient.getObject(bucket, key, (err, stream) => {
        if (err) {
          res.status(500).send(`Failed to get object in bucket ${bucket} at path ${key}: ${err}`);
          return;
        }

        try {
          let contents = '';
          stream.pipe(new tar.Parse()).on('entry', (entry: Stream) => {
            entry.on('data', (buffer) => contents += buffer.toString());
          });

          stream.on('end', () => {
            res.send(contents);
          });
        } catch (err) {
          res.status(500).send(`Failed to get object in bucket ${bucket} at path ${key}: ${err}`);
        }
      });
      break;
    default:
      res.status(500).send('Unknown storage source: ' + source);
      return;
  }
};

const getTensorboardHandler = async (req, res) => {
  if (!k8sHelper.isInCluster) {
    res.status(500).send('Cannot talk to Kubernetes master');
    return;
  }
  const logdir = decodeURIComponent(req.query.logdir);
  if (!logdir) {
    res.status(404).send('logdir argument is required');
    return;
  }

  try {
    res.send(await k8sHelper.getTensorboardAddress(logdir));
  } catch (err) {
    res.status(500).send('Failed to list Tensorboard pods: ' + err);
  }
};

const createTensorboardHandler = async (req, res) => {
  if (!k8sHelper.isInCluster) {
    res.status(500).send('Cannot talk to Kubernetes master');
    return;
  }
  const logdir = decodeURIComponent(req.query.logdir);
  if (!logdir) {
    res.status(404).send('logdir argument is required');
    return;
  }

  try {
    await k8sHelper.newTensorboardPod(logdir);
    const tensorboardAddress = await k8sHelper.waitForTensorboard(logdir, 60 * 1000);
    res.send(tensorboardAddress);
  } catch (err) {
    res.status(500).send('Failed to start Tensorboard app: ' + err);
  }
};

const logsHandler = async (req, res) => {
  if (!k8sHelper.isInCluster) {
    res.status(500).send('Cannot talk to Kubernetes master');
    return;
  }

  const podName = decodeURIComponent(req.query.podname);
  if (!podName) {
    res.status(404).send('podname argument is required');
    return;
  }

  try {
    res.send(await k8sHelper.getPodLogs(podName));
  } catch (err) {
    res.status(500).send('Could not get main container logs: ' + err);
  }
};

function _getAndSetMetadataAndWorkflows(displayRuns: DisplayRun[]): Promise<DisplayRun[]> {
  // Fetch and set the workflow details
  return Promise.all(displayRuns.map(async displayRun => {
    let getRunResponse: ApiRunDetail;
    try {
      getRunResponse = await Apis.runServiceApi.getRun(displayRun.metadata!.id!);
      displayRun.metadata = getRunResponse.run!;
      displayRun.workflow =
        JSON.parse(getRunResponse.pipeline_runtime!.workflow_manifest || '{}');
    } catch (err) {
      // This could be an API exception, or a JSON parse exception.
      displayRun.error = await errorToMessage(err);
    }
    return displayRun;
  }));
}

/**
 * For each DisplayRun, get its ApiRun and retrieve that ApiRun's Pipeline ID if it has one, then
 * use that Pipeline ID to fetch its associated Pipeline and attach that Pipeline's name to the
 * DisplayRun. If the ApiRun has no Pipeline ID, then the corresponding DisplayRun will show '-'.
 */
function _getAndSetPipelineNames(displayRuns: DisplayRun[]): Promise<DisplayRun[]> {
  return Promise.all(
    displayRuns.map(async (displayRun) => {
      const pipelineId = RunUtils.getPipelineId(displayRun.metadata);
      if (pipelineId) {
        try {
          const pipeline = await Apis.pipelineServiceApi.getPipeline(pipelineId);
          displayRun.pipeline = { displayName: pipeline.name || '', id: pipelineId, showLink: false };
        } catch (err) {
          // This could be an API exception, or a JSON parse exception.
          displayRun.error = 'Failed to get associated pipeline: ' + await errorToMessage(err);
        }
      } else if (!!RunUtils.getPipelineSpec(displayRun.metadata)) {
        displayRun.pipeline = { showLink: true };
      }
      return displayRun;
    })
  );
}

/**
 * For each DisplayRun, get its ApiRun and retrieve that ApiRun's Experiment ID if it has one,
 * then use that Experiment ID to fetch its associated Experiment and attach that Experiment's
 * name to the DisplayRun. If the ApiRun has no Experiment ID, then the corresponding DisplayRun
 * will show '-'.
 */
function _getAndSetExperimentNames(displayRuns: DisplayRun[]): Promise<DisplayRun[]> {
  return Promise.all(
    displayRuns.map(async (displayRun) => {
      const experimentId = RunUtils.getFirstExperimentReferenceId(displayRun.metadata);
      if (experimentId) {
        try {
          // TODO: Experiment could be an optional field in state since whenever the RunList is
          // created from the ExperimentDetails page, we already have the experiment (and will)
          // be fetching the same one over and over here.
          const experiment = await Apis.experimentServiceApi.getExperiment(experimentId);
          displayRun.experiment = { displayName: experiment.name || '', id: experimentId };
        } catch (err) {
          // This could be an API exception, or a JSON parse exception.
          displayRun.error = 'Failed to get associated experiment: ' + await errorToMessage(err);
        }
      }
      return displayRun;
    })
  );
}

const runsWithDetailsHandler = async (req, res) => {
  const pageToken = req.query.pageToken;
  const pageSize = req.query.pageSize;
  const sortBy = req.query.sortBy;
  const resourceReferenceKeyType = req.query.resourceReferenceKeyType;
  const resourceReferenceKeyId = req.query.resourceReferenceKeyId;
  const filter = req.query.filter;

  const response = await Apis.runServiceApi.listRuns(
    pageToken,
    pageSize,
    sortBy,
    resourceReferenceKeyType,
    resourceReferenceKeyId,
    filter,
  );

  const displayRuns: DisplayRun[] = (response.runs || []).map(r => ({ metadata: r }));
  const nextPageToken = response.next_page_token || '';

  await _getAndSetMetadataAndWorkflows(displayRuns);
  await _getAndSetPipelineNames(displayRuns);
  await _getAndSetExperimentNames(displayRuns);

  res.json({ displayRuns, nextPageToken });
};

app.get('/' + v1beta1Prefix + '/healthz', healthzHandler);
app.get(BASEPATH + '/' + v1beta1Prefix + '/healthz', healthzHandler);

app.get('/artifacts/get', artifactsHandler);
app.get(BASEPATH + '/artifacts/get', artifactsHandler);

app.get('/apps/tensorboard', getTensorboardHandler);
app.get(BASEPATH + '/apps/tensorboard', getTensorboardHandler);

app.post('/apps/tensorboard', createTensorboardHandler);
app.post(BASEPATH + '/apps/tensorboard', createTensorboardHandler);

app.get('/k8s/pod/logs', logsHandler);
app.get(BASEPATH + '/k8s/pod/logs', logsHandler);

// Order matters here, since both handlers can match any proxied request with a referer,
// and we prioritize the basepath-friendly handler
proxyMiddleware(app, BASEPATH + '/' + v1beta1Prefix);
proxyMiddleware(app, '/' + v1beta1Prefix);

app.get('/' + middlewarePrefix + '/listRunsWithDetails', runsWithDetailsHandler);
app.get(BASEPATH + '/' + middlewarePrefix + '/listRunsWithDetails', runsWithDetailsHandler);

app.all('/' + v1beta1Prefix + '/*', proxy({
  changeOrigin: true,
  onProxyReq: proxyReq => {
    console.log('Proxied request: ', (proxyReq as any).path);
  },
  target: apiServerAddress,
}));

app.all(BASEPATH + '/' + v1beta1Prefix + '/*', proxy({
  changeOrigin: true,
  onProxyReq: proxyReq => {
    console.log('Proxied request: ', (proxyReq as any).path);
  },
  pathRewrite: (path) =>
    path.startsWith(BASEPATH) ? path.substr(BASEPATH.length, path.length) : path,
  target: apiServerAddress,
}));

app.use(BASEPATH, StaticHandler(staticDir));
app.use(StaticHandler(staticDir));

app.get('*', (req, res) => {
  // TODO: look into caching this file to speed up multiple requests.
  res.sendFile(path.resolve(staticDir, 'index.html'));
});

app.listen(port, () => {
  console.log('Server listening at http://localhost:' + port);
});
