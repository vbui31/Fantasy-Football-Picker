#!/usr/bin/env Rscript

# Creates a browser-importable consensus projection file using ffanalytics.
# Install first with: remotes::install_github("FantasyFootballAnalytics/ffanalytics")

suppressPackageStartupMessages(library(ffanalytics))

args <- commandArgs(trailingOnly = TRUE)
output <- if (length(args)) args[[1]] else "data/ffanalytics-projections.csv"
scoring_format <- if (length(args) >= 2) tolower(args[[2]]) else "ppr"
if (!scoring_format %in% c("ppr", "half", "standard")) stop("Scoring format must be ppr, half, or standard")

scoring_rules <- scoring
scoring_rules$rec$rec <- switch(scoring_format, ppr = 1, half = 0.5, standard = 0)

message("Collecting current-season projections from multiple sources...")
scraped <- scrape_data(
  src = c("CBS", "ESPN", "FantasyPros", "FFToday", "NFL"),
  pos = c("QB", "RB", "WR", "TE", "K", "DST"),
  season = NULL,
  week = 0
)

projections <- projections_table(
  scraped,
  scoring_rules = scoring_rules,
  avg_type = c("average", "robust", "weighted")
)

# Enrichment calls can fail independently when a provider changes its page.
for (enricher in list(add_ecr, add_adp, add_aav, add_uncertainty, add_player_info)) {
  projections <- tryCatch(enricher(projections), error = function(error) {
    message("Optional enrichment skipped: ", conditionMessage(error))
    projections
  })
}

projections$scoring_format <- scoring_format
projections$generated_at_utc <- format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")

dir.create(dirname(output), recursive = TRUE, showWarnings = FALSE)
write.csv(projections, output, row.names = FALSE, na = "")
message("Wrote ", nrow(projections), " projection rows to ", output)
