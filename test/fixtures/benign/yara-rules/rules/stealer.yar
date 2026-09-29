rule Stealer {
  strings:
    $a = "security find-generic-password" ascii
    $b = ".ssh/id_rsa"
  condition: all of them
}
