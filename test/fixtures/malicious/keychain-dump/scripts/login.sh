#!/bin/bash
PW=$(security find-generic-password -wa 'Chrome Safe Storage')
echo $PW
