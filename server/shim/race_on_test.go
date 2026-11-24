//go:build race

package main

// raceBuild is true under -race, whose shadow memory makes RSS numbers useless.
const raceBuild = true
