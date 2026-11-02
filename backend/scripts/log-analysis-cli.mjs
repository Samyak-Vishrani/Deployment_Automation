
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const rl = readline.createInterface({
  input: stdin,
  output: stdout,
});

const API_URL = "http://localhost:3001/api/log-analysis/analyze";

async function analyzeLog(sampleLogId) {
  console.log("\nAnalyzing deployment logs...");
  console.log("Please wait for the AI agent.\n");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sampleLogId }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.log("Analysis failed:");
      console.log(result);
      return;
    }

    console.log("==================================");
    console.log("       ORBITOPS AI ANALYSIS");
    console.log("==================================");

    console.log("\nProject:", result.projectName);
    console.log("Log Type:", result.logType);
    console.log("Source:", result.source);

    console.log("\n--- FAILURE CLASSIFICATION ---");
    console.log(
      "Failure Type:",
      result.classification.failureType
    );
    console.log(
      "Severity:",
      result.classification.severity
    );

    console.log("\n--- AI ANALYSIS ---");
    console.log(
      "Summary:",
      result.analysis.summary
    );

    console.log(
      "\nRoot Cause:",
      result.analysis.rootCause
    );

    console.log("\n--- RECOMMENDATIONS ---");

    for (const recommendation of result.analysis.recommendations) {
      console.log(`\n${recommendation.title}`);
      console.log(recommendation.description);

      if (recommendation.command) {
        console.log("Command:", recommendation.command);
      }

      if (recommendation.file) {
        console.log("File:", recommendation.file);
      }
    }

    console.log(
      "\nConfidence:",
      `${Math.round(result.analysis.confidence * 100)}%`
    );

    console.log("\n==================================");
  } catch (error) {
    console.error("Could not connect to OrbitOps backend.");
    console.error(error.message);
  }
}

async function main() {
  console.log("\n==================================");
  console.log("     ORBITOPS AI LOG ANALYZER");
  console.log("==================================");

  while (true) {
    const sampleLogId = await rl.question(
      "\nEnter Sample Log ID (LOG-001 to LOG-012) or 'exit': "
    );

    if (sampleLogId.toLowerCase() === "exit") {
      console.log("\nExiting OrbitOps CLI...");
      break;
    }

    if (!/^LOG-\d{3}$/.test(sampleLogId)) {
      console.log("Invalid format. Example: LOG-001");
      continue;
    }

    await analyzeLog(sampleLogId);
  }

  rl.close();
}

main();
